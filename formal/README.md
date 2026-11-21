# Formal models of phone-code

Two tiers. The TLA+ models below check the daemon's state machines with
honest participants (crashes, persistence, races). The Tamarin model in
[`tamarin/`](#tamarin-attacker-model-of-pairing-and-authentication) checks
pairing and authentication against an attacker who controls the network,
runs web pages in the user's browser, and may see the QR or steal a token.

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
- `RevokeCascades`. No device paired through a revoked device's handoff
  codes (transitively) is in the store or has an authorized socket.
  `PairingAuth_bug_cascade.cfg` (`FixCascade = FALSE`, the code before the
  lineage fix) pins the counterexample: Pair, Handoff(d1), Pair(child) →
  RevokeViaControl(d1), and the child stays authorized.
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

The scripts that reproduced bugs 1-6 against a real daemon are now e2e
regression tests, each checking the invariant the fix restored so that it
holds in every interleaving rather than depending on hitting a window:

- Bug 1: `e2e/tests/sync-regressions.spec.ts` (restart, read the seq, kill -9
  at once, restart: the new seq must be larger). No timing involved.
- Bug 2: same file (sub + unsub right after a restart, a second connection
  waits for the same transcript load; no frames may follow the unsub).
- Bug 3, 4: `e2e/tests/revocation.spec.ts` (kill -9 right after the CLI
  printed "Revoked").
- Bug 5: `e2e/tests/startup-revoke.spec.ts`. A fake `tailscale` on PATH holds
  startup open (`status` reports HTTPS, `serve` waits for a file the test
  creates), so the window is deterministic. No `--tunnel`.
- Bug 6: same sync file, but it can no longer catch a regression of the core
  fix alone: the Claude and Codex adapters now re-report their real status
  after every send, which masks it. It guards the user-visible behaviour.

Removing each fix (tried for 1-5 and for the cascade, Host, Origin, client-key
and link fixes) makes its test fail.

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
- **Availability**: only the typed form of a pairing code is rate limited
  (per client, keyed on the proxy-reported address, and 40 failures a minute
  overall), so someone who can reach `/api/pair` can keep typed pairing
  blocked; the QR link and handoff codes cannot be blocked (`Pair(c, ip,
  "link")` ignores the limit). Not checked as a property. A paired device can
  also evict the banner pairing code by minting `MAX_ACTIVE_CODES` handoff
  codes (the web app keeps at most two alive: it re-mints every 3 minutes).
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

## Tamarin: attacker model of pairing and authentication

`tamarin/PhoneCode.spthy`, checked by `tamarin/check.sh` with Tamarin 1.12.0
and Maude 3.5.1 (official GitHub release binaries, Linux x86_64, pinned by
SHA-256, downloaded into `formal/.tools/`). The script proves every lemma in
every deployment variant (one Tamarin process per lemma, `JOBS` in parallel)
and fails on any result that differs from the table in the script, or on a
timeout. `TAMARIN_OUT=dir` keeps each proof and attack trace.

### What is modelled (each rule names its code)

- Channels per deployment. `Req`/`Res` facts are the TLS connection between
  the phone and the daemon (tailscale serve, cloudflared, a `--url` proxy,
  loopback): the attacker cannot read, inject or replay. `NET_CLIENT` lets the
  attacker open its own connection and read the answers (tunnel URL, your
  proxy, a tailnet member, another local user). `PLAIN` puts the phone's
  traffic on the attacker's wire (`--insecure`, or a tunnel operator who is the
  attacker: the same rules). In every variant, web pages in the user's
  browser can post to `127.0.0.1` without reading the answer (`csrf`) and
  can DNS-rebind a name to it and read answers (`rebind`).
- The QR is authentic (the attacker cannot change what the terminal shows);
  `QR_LEAK` makes it non-confidential (photo, shoulder surfing). The pairing
  URL keeps the code in the fragment and responses carry
  `Referrer-Policy: no-referrer`, so the URL is not leaked via Referer or
  server logs; browser history and screenshots are the QR_LEAK case.
  `HANDOFF_LEAK` leaks the `?h=` handoff code (page URL, manifest start_url,
  history, a proxy log). The web app re-mints it every 3 minutes while the
  install coach is open; every mint is a fresh code in the model, so that is
  covered. `COMPROMISE` steals one device's token.
- Daemon: pairing and handoff codes are linear facts (single use, expiry and
  eviction consume them); devices are `!Dev(id, lineage, token)`, where a
  handoff child's lineage is `<id, parent, parent's lineage>`. Revocation is
  modelled by restrictions on lookups (`live_self`, `live_cascade`); the Host
  and Origin checks are restrictions on the `rebind` / `csrf` channels. Old
  behaviour can be switched back on: `NO_CASCADE`, `NO_HANDOFF_FORGET`,
  `NO_HOST_CHECK`, `NO_ORIGIN_CHECK`.
- Assumed: ideal TLS with certificate checking by the phone; unguessable
  codes, tokens and control secret (no guessing, so the rate limit is out of
  scope); an honest browser (origin-scoped localStorage, no XSS, no custom
  headers cross-origin, no-cors answers unreadable); a private terminal and
  `control.json`; JSON string ids/tokens (no type confusion); one daemon
  epoch (crashes and in-flight requests are the TLA+ model's job). A paired
  device's shell, which could read `control.json`, is not a protocol step.

### Lemmas

Source lemmas (`src_*`, `no_att_auth`, `src_auth_thief`, all `[reuse]`, some
by induction) name the only ways the attacker learns a code or token: a
leaked QR, a leaked handoff URL, a stolen token. They must verify wherever
they are defined. The others:

| Lemma                                                       | In plain words                                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `exec_*`                                                    | The honest runs exist: pair + hello, handoff child + hello, owner revoke.                                             |
| `token_secret`                                              | The token of a device your phone paired stays secret (unless stolen).                                                 |
| `pair_code_secret`, `handoff_code_secret`, `control_secret` | A code you did not leak, a handoff code minted for your phone, the control secret: never learned.                     |
| `sessions_only_owner_devices`                               | A socket is authorized only for a device your phone paired.                                                           |
| `hello_injective_agreement`                                 | Every authorized socket is one your phone opened for that device; a captured hello authorizes no other.               |
| `codes_redeemed_only_by_owner`                              | Every device created from a code was created by your phone's request.                                                 |
| `code_single_use`                                           | A code yields at most one device, even when leaked.                                                                   |
| `owner_first_excludes_others`                               | Once your phone redeemed a code, nobody else gets a device from it.                                                   |
| `race_loss_is_visible`                                      | If someone else redeemed it first, your phone got no device from it (it shows the error).                             |
| `no_pair_after_expiry`                                      | An expired or evicted code pairs nothing.                                                                             |
| `handoff_bound_to_minter`                                   | A handoff device is the child of the device that minted the code, and only a holder of that device's token minted it. |
| `no_handoff_after_revoke`                                   | A handoff code minted before its device was revoked pairs nothing afterwards.                                         |
| `revoked_no_session`, `revoke_cascades`                     | After a revocation, no socket for the device or any device paired through it.                                         |
| `revoke_only_owner_or_holder`                               | Only your CLI, the device itself, or a holder of its token revokes it.                                                |
| `revoke_evicts_thief`                                       | After you revoke a stolen device, the thief has no socket left, through it or anything it paired.                     |
| `control_only_owner_cli`                                    | Only your CLI is accepted on `/_control` (no network attacker, no CSRF or rebinding page).                            |

### Results

Every result matched its expectation. Per-lemma results with steps and
seconds: [`tamarin/results.txt`](tamarin/results.txt). A full
`tamarin/check.sh` takes about 35 minutes on 4 cores (262 proofs; the
per-lemma timeout is 1200 s, the heap 3.5 GB per proof).

| Variant                        | Lemmas | Verified | Falsified (attack found)                                                                                                                                        | Proof time (sum / slowest)                   |
| ------------------------------ | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `tailscale`                    | 25     | 25       | none                                                                                                                                                            | 172 s / 27 s `exec_owner_revoke`             |
| `public`                       | 25     | 25       | none                                                                                                                                                            | 245 s / 29 s `exec_owner_revoke`             |
| `tailscale_qr_seen`            | 24     | 24       | none                                                                                                                                                            | 119 s / 17 s `exec_owner_revoke`             |
| `tailscale_qr_seen_old_host`   | 24     | 21       | `codes_redeemed_only_by_owner` (5 s), `hello_injective_agreement` (9 s), `sessions_only_owner_devices` (11 s)                                                   | 206 s / 22 s `exec_owner_revoke`             |
| `tailscale_qr_seen_old_origin` | 24     | 23       | `codes_redeemed_only_by_owner` (4 s)                                                                                                                            | 149 s / 19 s `exec_owner_revoke`             |
| `public_qr_seen`               | 24     | 21       | `codes_redeemed_only_by_owner` (6 s), `hello_injective_agreement` (12 s), `sessions_only_owner_devices` (12 s)                                                  | 245 s / 24 s `exec_owner_revoke`             |
| `public_handoff_leak`          | 24     | 20       | `codes_redeemed_only_by_owner` (81 s), `handoff_code_secret` (64 s), `hello_injective_agreement` (132 s), `sessions_only_owner_devices` (148 s)                 | 1320 s / 282 s `src_control_secret`          |
| `stolen_token`                 | 26     | 23       | `codes_redeemed_only_by_owner` (49 s), `hello_injective_agreement` (129 s), `sessions_only_owner_devices` (228 s)                                               | 1370 s / 228 s `sessions_only_owner_devices` |
| `stolen_token_old_nocascade`   | 25     | 21       | `codes_redeemed_only_by_owner` (32 s), `hello_injective_agreement` (84 s), `revoke_evicts_thief` (612 s), `sessions_only_owner_devices` (130 s)                 | 1354 s / 612 s `revoke_evicts_thief`         |
| `old_handoff_forget`           | 25     | 24       | `no_handoff_after_revoke` (26 s)                                                                                                                                | 171 s / 26 s `exec_owner_revoke`             |
| `insecure`                     | 15     | 10       | `codes_redeemed_only_by_owner` (5 s), `hello_injective_agreement` (23 s), `pair_code_secret` (5 s), `sessions_only_owner_devices` (46 s), `token_secret` (76 s) | 238 s / 76 s `token_secret`                  |

Not every lemma is defined in every variant: the `[reuse]` source lemmas only
where they hold, `revoke_evicts_thief` / `src_auth_thief` only with a stolen
token, and under `PLAIN` the `exec_*` sanity lemmas, `handoff_code_secret`,
`owner_first_excludes_others` and `race_loss_is_visible` are left out: there
the attacker owns the wire and can forge the phone's answers, these say
nothing, and their searches run out of memory or time (the falsified lemmas'
attack traces already show the protocol running). `revoke_cascades` is left
out under `NO_CASCADE`, where `revoke_evicts_thief` carries the counterexample.

### Findings

1. **DNS rebinding (real, fixed).** `tailscale_qr_seen_old_host`: with
   Tailscale, an attacker who only photographed the QR is off the tailnet and
   cannot use it, except through the user's own browser: a page on the
   attacker's domain, rebound to `127.0.0.1:7777`, is same-origin with itself,
   so it could POST the code to `/api/pair`, read the token, and open `/ws`
   (`originAllowed` accepted it because Origin's host equals Host). Trace:
   Leak_QR, Page_Rebind(pair), Page_RebindAnswer, Page_Rebind(hello),
   D_Hello. Fix: `http/server.ts` `hostAllowed` on `/api`, `/ws`,
   `/_control`. e2e: `pairing-limits.spec.ts`.
2. **CSRF on `/api/pair` (real, fixed).** `tailscale_qr_seen_old_origin`: a
   foreign page could post a no-cors form to `/api/pair`, burning a seen code
   (the owner's phone then fails) or the typed-code rate limit. It cannot read
   the token, so `sessions_only_owner_devices` still holds. Fix: POST
   `/api/*` with a foreign Origin gets 403.
3. **Revocation did not cascade (real, fixed).** `stolen_token_old_nocascade`:
   a thief with a token mints a handoff code, pairs its own device, and keeps
   it after the owner revokes the stolen one (`revoke_evicts_thief`
   falsified). Fix: `DeviceRecord.parent`, `DeviceStore.revoke` removes
   descendants transitively, `PairingCodes.forgetDevices` drops their codes;
   `phonecode devices` shows `via <id>`, `revoke` lists what went with it.
   Cost: unpairing the Safari device also unpairs the Home Screen app set up
   from it (the dialog says so). TLA+: `RevokeCascades`.
4. **Expected, documented limits.** `public_qr_seen`, `public_handoff_leak`:
   whoever holds a code while it is valid and can reach the endpoint wins the
   race for that one device; single use and visibility hold, and a handoff
   device dies with its parent. `stolen_token`: the thief is a user until you
   revoke (then `revoke_evicts_thief` holds). `insecure` (= tunnel operator as
   attacker): token, codes and sessions are all lost; trace for
   `token_secret`: Phone_Hello, Net_PhoneOut (the attacker reads the token),
   Net_DaemonIn / Att_Connect with it, D_Hello. Control lemmas still hold.
5. `old_handoff_forget` keeps PairingAuth bug 3 demonstrated in this model too.
