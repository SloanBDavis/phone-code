# Formal models of phone-code

TLA+ specifications of the three pieces of protocol logic that are easy to
get wrong and hard to test, checked with TLC. They model the daemon as it is
implemented (each action names the file and function it stands for), not an
idealized design. Running `formal/check.sh` downloads `tla2tools.jar` (v1.8.0,
pinned by SHA-256) into `formal/.tools/` and checks every config. It exits
non-zero on any unexpected result.

```
formal/check.sh               # default configs, about 3.5 min on 4 cores
formal/check.sh --extended    # plus the large ChatSync safety run
formal/check.sh PermissionReq.cfg
```

There are two kinds of config. The first line of each `.cfg` says which kind
it is:

- **must pass**: the code as it is now.
- **"Expected to FAIL"**: these pin a counterexample. Each one is either a bug
  that has been fixed (the config turns the fix off through a `Fix*`
  constant) or a documented limitation. `check.sh` fails if one of these stops
  producing its counterexample, so the model keeps demonstrating it.

## What the model checking found

Six counterexamples matched real bugs. For each one, the trace was confirmed
against the code and reproduced against the running daemon with a script (see
"Reproductions" below). Each was then fixed in the daemon core, and the spec was
re-checked with the fix in place.

| #   | Spec / config                                  | Bug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Fix                                                                                                                                                                                                              |
| --- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ChatSync / `ChatSync_bug.cfg`                  | **A restored session can reuse a seq the previous epoch already handed out.** `ChatSession.restore` sets `seq = persisted seq + 100000`, but nothing wrote that jumped seq back to `sessions.json`. A crash before the next write restores _the same_ seq again, while the transcript file (flushed after 250 ms) has moved on. A phone holding that seq resumes with `afterSeq`. `EventLog.since(S, S)` returns `[]`, so the phone keeps the stale transcript and applies every later event on top of the wrong base. Reproduced 5/7 runs with kill -9 at 255-295 ms after a message. | `sessions/manager.ts` `SessionManager.load`: `await m.writer.flush()` after restoring, before the server starts. The jumped seqs are then durable before any client can see them.                                |
| 2   | ChatSync / `ChatSync_ghost.cfg`                | **A `sub` that waits for a restored transcript to load completes after the client's `unsub`** and puts the connection back in the fanout. The phone keeps receiving the session's events. Because `fanout.size > 0`, the daemon also never sets `unread` and suppresses the "turn finished" and "waiting" push notifications. Reproduced: 5 frames after `unsub`, `unread` stayed `false`.                                                                                                                                                                                             | `ws-client.ts` `Connection.attach` (used by `route('sub')` and `onDrain`): after `subscribe` resolves, unsubscribe again if the client unsubscribed or the socket closed meanwhile.                              |
| 3   | PairingAuth / `PairingAuth_bug_handoff.cfg`    | **A handoff code minted before a revocation still pairs afterwards.** The revoked phone (or whoever holds its token) can mint `/api/handoff` codes ahead of time and redeem one after `phonecode revoke`, which gives it a fresh device and token. Reproduced: HTTP 200 and a working socket.                                                                                                                                                                                                                                                                                          | `auth/pairing.ts`: handoff codes record their `issuer`, and `PairingCodes.forgetDevice` drops them. `daemon.ts` `control.revoke` calls it, and `http/server.ts` `handoff()` passes the device id.                |
| 4   | PairingAuth / `PairingAuth_bug_durable.cfg`    | **"Revoked" was printed before `devices.json` was written** (JsonWriter, 500 ms debounce). A crash in that window brings the device back. Reproduced with kill -9 right after the CLI returned.                                                                                                                                                                                                                                                                                                                                                                                        | `http/server.ts`: `/_control/revoke` and `/api/unpair` answer only after `devices.flush()`.                                                                                                                      |
| 5   | PairingAuth / `PairingAuth_bug_offline.cfg`    | **An offline `phonecode revoke` under a running daemon is silently undone.** While the daemon is starting, the server already accepts connections but `control.json` is not written yet. This window lasts seconds with `--tunnel` or tailscale. In that window the CLI edits `devices.json` itself. The daemon still has the device in memory, keeps accepting its token, and writes it back on its next save. Reproduced with a slow `cloudflared`.                                                                                                                                  | `daemon.ts` `startDaemon` writes a `control.json` (pid, port 0) before it reads `devices.json`. `cli.ts` `revokeCommand` refuses the offline path while that pid is alive (`control-client.ts` `liveDaemonPid`). |
| 6   | PermissionReq / `PermissionReq_bug_status.cfg` | **A message sent while a permission or question is pending flips the session from `waiting` to `running`**, and it stays `running` until the card is answered. `ChatSession.deliver` called `setStatus('running')`, and the adapter's `StatusTracker` only reports changes, so it never corrects it. The phone's session list and "waiting" attention are then wrong. Reproduced with the real Claude adapter and the e2e fake CLI.                                                                                                                                                    | `sessions/chat.ts` `deliver`: does not overwrite `waiting`.                                                                                                                                                      |

After each fix, `bunx oxlint --type-aware --deny-warnings packages/daemon/src`,
`bunx oxfmt --check` on the touched files and the daemon typecheck pass.

Two counterexamples are **documented limitations** (by design, not fixed), each pinned by a config:

- `PairingAuth_inflight.cfg` (`NoEffectAfterRevoke`). An rpc that the daemon
  received _before_ the revocation and whose handler is awaiting I/O still
  takes effect afterwards. Examples: `session.create` (awaits
  `assertDirectory`), and `chat.send` to a transcript not yet loaded. Trace:
  Pair, Open, Hello, Message (handler starts) → RevokeViaControl → WorkDone.
  Nothing the revoked device sends _after_ the revocation is acted on
  (`NoActAfterRevoke` holds): `registry.closeDevice` closes the socket
  synchronously, and `dispatch` checks `closed`.
- `PermissionReq_forward.cfg` (`CoreForwardsOnlyPending`). The core
  (`ChatSession.resolvePermission` / `answerQuestion`) forwards every decision
  to the adapter, even for a card that was already answered, cancelled by an
  interrupt, or settled by a restart. Trace: Ask → phone sees it → Interrupt →
  the phone taps Deny on its stale card → the decision reaches the adapter. The
  adapters filter by their pending map: `claude.ts`, `codex.ts` and `acp.ts` all
  return early when the id is not pending. So the agent CLI never sees such an
  answer (`NoAnswerAfterCancel` and `AtMostOnce` hold with the Claude adapter's
  logic). A new adapter must keep doing this.

## The models

### `ChatSync.tla`: transcript sync for one chat session

The model has a daemon session that emits item upserts and coalesced deltas
with increasing `seq`, and one phone that keeps losing its socket and
resubscribes with `afterSeq`. It also covers the bounded replay log with
snapshot fallback, backpressure skip-to-snapshot, unsub/resub, transcript and
`sessions.json` persistence at arbitrary times, and clean or crash restarts
with the seq jump.

| Action                                     | Code                                                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Upsert(i)`                                | `sessions/chat.ts` `ChatSession.upsert` → `emit` (`EventLog.push`, `Fanout.publish`)                                                                                                 |
| `Delta(i)`, `FlushDelta`                   | `ChatSession.delta` (pendingDelta coalescing), `ChatSession.flushDelta` (timer, or called by upsert/setStatus/subscribe/persist; a delta for an unknown id is dropped without a seq) |
| `PushLog`, `Since`                         | `sessions/event-log.ts` `EventLog.push` (maxEvents, and maxBytes over-approximated as "evict any number, keep one"), `EventLog.since`                                                |
| `Publish`, `SendAll`                       | `sessions/fanout.ts` `Fanout.publish` / `sendTo` with `ws-client.ts` `Connection.sendFrame` (false above `SOFT_BUFFER_LIMIT`) and `markStale`                                        |
| `RecvSub`, `SubFinish`                     | `ws-client.ts` `route('sub')` → `Connection.attach` → `ChatSession.subscribe`, split at `await ensureLoaded()`                                                                       |
| `RecvUnsub`                                | `route('unsub')`                                                                                                                                                                     |
| `Drain`                                    | `Connection.onDrain` (resubscribe stale sessions with a fresh snapshot)                                                                                                              |
| `Connect`, `Disconnect`                    | `web/src/lib/ws.ts` reconnect + `client.ts` `onMessage('ready')` re-sending `sub` with `seqs.get(id)`; `Connection.onClose`                                                          |
| `Receive`, `Apply`                         | `web/src/lib/client.ts` `onMessage` (inbox), `flush` + `fresh`; `state.ts` `resetChat` / `upsertItem` / `appendDelta`                                                                |
| `Unsub`, `Resub`                           | `client.ts` `subscribe` ref count (chat state and seq kept on unsub)                                                                                                                 |
| `FileFlush`, `PersistSeq`                  | `sessions/transcript-file.ts` `touch`/`flush`; `util/files.ts` `JsonWriter` via `SessionManager.changed`                                                                             |
| `CleanRestart`, `CrashRestart`, `NewEpoch` | `daemon.ts` `stop` → `SessionManager.shutdown`; `SessionManager.load` → `ChatSession.restore` (`RESTORE_SEQ_MARGIN`, new `EventLog(seq)`), transcript `load`                         |

JS scheduling is modeled with `Macrotask`. Once the transcript is loaded, the
rest of a `subscribe` is a microtask, so no socket event can run in between.
While a restored transcript is still being read from disk, socket events can
interleave (this is how bug 2 happens).

Properties:

- `CaughtUpMeansEqual` (safety, the main one). If the phone's rendered seq
  _n_ is a seq of the current daemon epoch, the phone's transcript equals the
  daemon's transcript at _n_. Item contents are the sequence of agent tokens
  that produced them, so any lost, duplicated or reordered delta, or any stale
  or resurrected item, breaks equality. So does resuming onto the wrong base.
- `NoGap`. The phone never applies an incremental frame across a hole in seq.
  Its seq goes backwards only through a snapshot.
- `NoGhostSubscriber`. The connection is in the session's fanout only while it
  is in the connection's `subs`.
- `LogConsistent`, `TypeOK`: sanity checks.
- `EventuallyConverges` (liveness, `<>[]`). With weak fairness on the daemon
  and phone steps and finite environment budgets (agent output, disconnects,
  restarts, backpressure failures), a connected, subscribed phone ends up with
  the daemon's seq and transcript.

Assumption: `Margin > MaxTok` (an `ASSUME`). This is the code's
`RESTORE_SEQ_MARGIN` argument: one epoch never emits more than 100000 events
between two successful writes of `sessions.json`. The model lets
`sessions.json` lag arbitrarily, and bounds an epoch's events by `MaxTok`
instead. In the real daemon, writes happen at most 1.3 s after activity. A disk
that keeps refusing writes for that long would break the assumption.

### `PairingAuth.tla`: pairing codes, handoff, tokens, revocation, hello deadline

| Action                                                               | Code                                                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Start`, `Ready`, `Crash`, `Stop`, `WriteDevices`                    | `daemon.ts` `startDaemon` order and `stop`; `auth/devices.ts` `DeviceStore.load` and JsonWriter (500 ms)                                                                 |
| `NewPairCode`, `Handoff(d)`                                          | `auth/pairing.ts` `PairingCodes.create` (prune, `MAX_ACTIVE_CODES` eviction); `http/server.ts` `handoff()`                                                               |
| `Expire(c)`                                                          | the `PAIR_CODE_TTL_MS` deadline passing                                                                                                                                  |
| `Pair(c, ip)`, `BadPair(ip)`, `MinutePasses`                         | `http/server.ts` `pair()` → `PairingCodes.redeem` (`isRateLimited`, `prune`, match, single-use delete, `recordFailure`) → `DeviceStore.add`                              |
| `Open`, `Hello`, `PreAuthFail`, `Message`, `WorkDone`, `ClientClose` | `ws-client.ts` `Connection` (hello timer, `hello` → `DeviceStore.authenticate`, pre-auth frame checks, `dispatch` checking `closed`, `rpc`)                              |
| `RevokeViaControl(d)`                                                | `/_control/revoke` → `daemon.ts` `control.revoke` (`devices.revoke`, `registry.closeDevice`, `pairing.forgetDevice`) → `devices.flush()`; `/api/unpair` is the same path |
| `RevokeOffline(d)`                                                   | `cli.ts` `revokeCommand` offline branch                                                                                                                                  |

Properties:

- `AuthedOnlyPaired`. A socket is authorized only for a device in the store
  that was minted by redeeming an issued code. The code was unexpired and
  unused at redemption because `redeem` prunes and matches atomically.
- `SingleUse`. A code never yields two devices. `PHONECODE_PAIR_CODE` is the
  explicit, separate exception: it is the model value `Fixed`, it is excluded
  from `SingleUse`, and `PairingAuth_fixedcode.cfg` checks that everything else
  still holds with it set.
- `RateLimitHolds`. Within one window, at most `FailIp` failed attempts per IP
  and `FailGlobal` overall reach the code comparison. (8 and 40 in the code; 1
  and 2 in the model.)
- `RevokedStaysRevoked`. Once the CLI said "Revoked", the device is not in the
  store, even after a crash and restart, and none of its sockets is
  authorized.
- `NoHandoffAfterRevoke`. A revoked device cannot come back through a handoff
  code it minted earlier.
- `NoActAfterRevoke`. No message from a revoked device is acted on after the
  revocation, including messages on an already open socket.
- `HelloDeadline` (liveness). Every unauthenticated socket is eventually
  authenticated or closed (weak fairness on the hello timeout).

### `PermissionReq.tla`: permission and question requests

The model has a request from the agent CLI, two phones with possibly stale
views answering concurrently, interrupts, end of turn, CLI crash and relaunch,
daemon restart, and messages sent while waiting. The Claude adapter's logic is
the reference adapter (read only; `codex.ts` and `acp.ts` have the same
pending-map shape). A question behaves like a permission here.

| Action                 | Code                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Send`, `Deliver`      | `ws-client.ts` `route('chat.send')` → `ChatSession.send` → `deliver` (`setStatus`, `agent.send`); `claude.ts` `send` / `launch`      |
| `Ask(r)`               | `claude.ts` `onControlRequest` (pending map, upsert pending, `StatusTracker.emit`)                                                   |
| `CliCancel(r)`         | `claude.ts` `control_cancel_request` → `settle(cancelled)`                                                                           |
| `See`, `Tap`           | the phone rendering (possibly stale) and the user answering                                                                          |
| `Decide(m)`            | `route('chat.permission')` → `ChatSession.resolvePermission` → `claude.ts` `resolvePermission` (pending lookup, `settle`, `respond`) |
| `Interrupt`            | `ChatSession.interrupt` → `claude.ts` `interrupt` (`cancelAllPending`)                                                               |
| `Result`, `AgentCrash` | `claude.ts` `onResult`, `onExit`                                                                                                     |
| `Restart`              | `ChatSession.restore` (running/waiting → idle), `transcript-file.ts` `settle` (pending → cancelled)                                  |
| `Emit`                 | `agents/shared/common.ts` `StatusTracker.emit` → `ChatSession.setStatus`                                                             |

Properties:

- `AtMostOnce`. The CLI gets at most one answer per request, and a settled
  card never becomes pending again.
- `NoAnswerAfterCancel`. No answer reaches the agent for a request that was
  cancelled by the CLI, an interrupt, the end of the turn, a crash or a
  restart.
- `CoreMatchesAdapter`. The transcript and the adapter agree on what is
  pending.
- `WaitingIffPending`. The session status is `waiting` exactly while a
  request is pending.

## Bounds, state counts, run times

These are separate runs with `-workers 4`, on a 4-core container. The whole default `check.sh` took 3 min 16 s.

| Config                                                      | Bounds                                                                                                 | Result                                | Distinct states | Time                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------- | --------------- | ------------------------------------------ |
| `ChatSync.cfg` (safety + liveness)                          | 2 items, 2 agent tokens, log 1, margin 3, 2 restarts, 1 disconnect, 1 backpressure drop, 1 unsub/resub | pass                                  | 3,054,758       | 2 min 23 s                                 |
| `ChatSync_safety.cfg` (`--extended`, safety, symmetry)      | 2 items, 3 tokens, log 2, margin 4, 2 restarts, 1 disconnect, 1 backpressure drop, 1 toggle            | pass                                  | 54,353,031      | 14 min 10 s (all 4 cores, `-workers auto`) |
| `ChatSync_bug.cfg`                                          | no persist-on-load                                                                                     | counterexample, 10 states deep        |                 | 1 s                                        |
| `ChatSync_ghost.cfg`                                        | no attach check                                                                                        | counterexample, 7 states deep         |                 | 1 s                                        |
| `PairingAuth.cfg` (safety, symmetry)                        | 3 codes, 2 devices, 2 sockets, 2 IPs, 2 daemon starts, `MaxActive` 2, limits 1 / 2                     | pass                                  | 80,623          | 17 s                                       |
| `PairingAuth_live.cfg` (safety + `HelloDeadline`)           | 2 codes, 2 devices, 1 socket, 1 IP                                                                     | pass                                  | 8,943           | 3 s                                        |
| `PairingAuth_fixedcode.cfg`                                 | as `PairingAuth.cfg` with `PHONECODE_PAIR_CODE`, 1 socket                                              | pass                                  | 375,232         | 29 s                                       |
| `PairingAuth_bug_*.cfg`, `PairingAuth_inflight.cfg`         | as `PairingAuth.cfg`, one fix off                                                                      | counterexample each, 7-12 states deep |                 | 1-3 s                                      |
| `PermissionReq.cfg`                                         | 2 requests, 2 phones, 2 sends, 1 restart, 1 CLI crash                                                  | pass                                  | 2,508,163       | 2 min 17 s                                 |
| `PermissionReq_bug_status.cfg`, `PermissionReq_forward.cfg` | same                                                                                                   | counterexample each                   |                 | 1 s                                        |

## Reproductions

The scripts that reproduced bugs 1-6 against a real daemon are not part of the
repository. Each one started `PHONECODE_HOME=<tmp> PHONECODE_ECHO_AGENT=1
PHONECODE_JSON=1 PHONECODE_PAIR_CODE=… bun packages/daemon/src/cli.ts`; bug 6
used `PHONECODE_CLAUDE_BIN=e2e/fakes/fake-claude.mjs` instead of the echo
agent. They then drove the daemon over HTTP and the websocket, and used
kill -9 where the trace has a crash. All six reproduced before the fix and not
after it. They are good candidates for e2e tests.

## What is _not_ covered

- **Terminal sessions** (`term.*` seq, `TerminalSession.restore`). They share
  the seq-jump design, and fix 1 covers them too (the same `sessions.json`
  write), but they are not modeled.
- **More than one phone at a time** in ChatSync. Subscribers are independent
  in `Fanout`, so one phone is representative. Multi-phone races are modeled
  in PermissionReq.
- **Item semantics**: kinds, the `streaming` flag, `settle()` on restore,
  sub-agent children (`parentId`), optimistic pending sends in the web client.
  Every item accepts deltas in the model.
- **A subscribe that finishes on a socket that already closed**, with an empty
  replay. Fix 2 covers it (`attach` checks `closed`), but the model drops
  closed sockets' pending subscribes.
- **Byte sizes**: `maxBytes` eviction is over-approximated, and `SOFT_BUFFER_LIMIT`
  is a nondeterministic send failure. Bun's own hard backpressure limit, which
  closes the socket with 1013, is modeled as a disconnect.
- **Cryptography**: codes and tokens are assumed unguessable, and guesses never
  match. Constant-time comparison and token hashing are not modeled.
- **Availability**: the global rate limit (40 failures per minute), and the
  per-IP limit behind a tunnel where every request comes from loopback, let an
  attacker block legitimate pairing indefinitely. This is a design trade-off
  and is not checked as a property. A paired device can also evict the banner
  pairing code by minting `MAX_ACTIVE_CODES` handoff codes.
- **Device lineage**: revoking a device does not revoke devices that were
  paired through its handoff codes _before_ the revocation. Those are listed
  separately in `phonecode devices`.
- **Two daemons on one state directory**, a failing disk, clock jumps.
- **Adapters other than Claude** in PermissionReq. Their pending maps were
  read, not modeled. Two adapter-side observations were not fixed, because the
  adapters are someone else's code:
  - `claude.ts` `send`: when the process cannot be written to, it posts a
    notice and returns without emitting a status. `deliver` has already set
    `running`, so the session stays `running`.
  - `claude.ts` `interrupt` returns early when `turnsQueued === 0`, so a
    prompt the CLI raised outside a counted turn cannot be cancelled by an
    interrupt (`onControlRequest` does not call `markBusy`). Not modeled, not
    reproduced.
  - The dev echo agent (`dev/echo-agent.ts`) reports its own `running` /
    `idle` while an earlier prompt is still pending. It is a development fake.
- **Web client**: its seq handling (`fresh`, snapshot reset, inbox replay
  after reconnect) is modeled and no bug was found in it. The UI is out of
  scope.
