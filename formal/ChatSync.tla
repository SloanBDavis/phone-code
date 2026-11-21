---------------------------- MODULE ChatSync ----------------------------
(***************************************************************************)
(* Chat transcript synchronisation between the daemon and one phone client *)
(* for ONE agent session, as implemented (not as designed).                 *)
(*                                                                         *)
(* Code being modelled (packages/daemon/src unless noted):                  *)
(*   sessions/chat.ts       ChatSession.upsert / delta / flushDelta / emit, *)
(*                          subscribe, restore (RESTORE_SEQ_MARGIN),        *)
(*                          persist                                         *)
(*   sessions/event-log.ts  EventLog.push (maxEvents + maxBytes eviction),  *)
(*                          EventLog.since                                  *)
(*   sessions/fanout.ts     Fanout.publish / sendTo (backpressure -> drop   *)
(*                          subscriber + markStale)                         *)
(*   sessions/manager.ts    SessionManager.load (restore), shutdown,        *)
(*                          JsonWriter-driven persistence of `seq`          *)
(*   sessions/transcript-file.ts  TranscriptFile.touch / flush / load       *)
(*   ws-client.ts           Connection.route 'sub' / 'unsub', sendFrame,    *)
(*                          markStale, onDrain, onClose                     *)
(*   web/src/lib/client.ts  Client.sendSub, onMessage('ready'), flush,      *)
(*                          fresh  (the phone's reducer: seq dedup)         *)
(*   web/src/lib/state.ts   resetChat / upsertItem / appendDelta            *)
(*                                                                         *)
(* Abstractions                                                            *)
(*  - An item's content is the sequence of agent "tokens" that produced it: *)
(*    an upsert sets it to <<t>>, a delta appends tokens.  A lost,          *)
(*    duplicated or reordered delta, or a stale item, makes contents differ.*)
(*  - Item kinds are not modelled: every item accepts deltas.               *)
(*  - settle() on restore (streaming->false, pending->cancelled) is not     *)
(*    modelled; it only changes contents that are always re-sent as a      *)
(*    snapshot.                                                             *)
(*  - The EventLog byte limit is over-approximated: a push may evict any    *)
(*    number of old frames as long as one is kept.                          *)
(*  - The async gap in ChatSession.subscribe (await ensureLoaded) is split  *)
(*    into SubStart / SubFinish so that agent events and further client     *)
(*    messages can interleave with a pending subscribe.                     *)
(*  - One client, one socket at a time.  A socket closing drops everything  *)
(*    in flight in both directions; the client's not-yet-rendered inbox     *)
(*    survives (Client.inbox is not cleared on reconnect).                  *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    Items,        \* item ids
    MaxTok,       \* agent output budget (upserts + delta chunks)
    LogMax,       \* EventLog maxEvents
    Margin,       \* RESTORE_SEQ_MARGIN
    MaxRestarts,  \* daemon restarts (clean or crash)
    MaxDisc,      \* socket drops
    MaxBP,        \* backpressure failures of sendFrame
    MaxToggle,    \* client unsub/resub toggles
    FixPersistOnLoad, \* TRUE = SessionManager.load persists the jumped seq before serving (the fix)
    None          \* model value: "undefined"

ASSUME Margin > MaxTok   \* "the margin exceeds what one epoch can emit" (see README)


VARIABLES
    \* ---- daemon, one ChatSession
    dSeq, dT, pend, dlog, base, hist, loaded,
    file, pSeq,              \* transcript file contents, seq in sessions.json
    \* ---- daemon, the Connection of the current socket
    inFan, subsHas, stale, subPend,
    \* ---- wire
    c2d, d2c,
    \* ---- phone
    cUp, wantSub, cHas, cSeq, cT, inbox,
    \* ---- bookkeeping
    tok, restarts, discs, bp, toggles, gap

daemonVars == <<dSeq, dT, pend, dlog, base, hist, loaded, file, pSeq>>
connVars   == <<inFan, subsHas, stale, subPend>>
clientVars == <<cUp, wantSub, cHas, cSeq, cT, inbox>>
bookVars   == <<tok, restarts, discs, bp, toggles, gap>>
vars == <<daemonVars, connVars, c2d, d2c, clientVars, bookVars>>

------------------------------------------------------------------------------
(* Transcripts: sequences of [id, c]; order of first appearance (ChatSession.place). *)

Has(T, i) == \E k \in 1..Len(T) : T[k].id = i
Put(T, i, c) ==
    IF Has(T, i)
    THEN [k \in 1..Len(T) |-> IF T[k].id = i THEN [id |-> i, c |-> c] ELSE T[k]]
    ELSE Append(T, [id |-> i, c |-> c])
Extend(T, i, s) ==
    [k \in 1..Len(T) |-> IF T[k].id = i THEN [id |-> i, c |-> T[k].c \o s] ELSE T[k]]

Frame(kind, n, i, s, T) == [kind |-> kind, seq |-> n, id |-> i, toks |-> s, items |-> T]

------------------------------------------------------------------------------
(* EventLog.push: append, then evict from the head.  Evicting a frame moves  *)
(* baseSeq to that frame's seq.                                              *)
PushLog(f) ==
    LET L == Append(dlog, f) IN
    \E drop \in 0..(Len(L) - 1) :
        /\ Len(L) - drop <= LogMax
        /\ dlog' = SubSeq(L, drop + 1, Len(L))
        /\ base' = IF drop = 0 THEN base ELSE L[drop].seq

(* EventLog.since(afterSeq, currentSeq): None when afterSeq fell out. *)
Since(after) ==
    IF after > dSeq \/ after < base THEN None
    ELSE LET idx == {k \in 1..Len(dlog) : dlog[k].seq > after}
         IN [j \in 1..Cardinality(idx) |-> dlog[j + (Len(dlog) - Cardinality(idx))]]

(* Fanout.publish -> sendTo -> Connection.sendFrame.  sendFrame is false when *)
(* the socket's buffer is above SOFT_BUFFER_LIMIT: nothing is sent, the        *)
(* subscriber is dropped and markStale records it if still in `subs`.          *)
Publish(f) ==
    IF inFan
    THEN \/ /\ d2c' = Append(d2c, f)
            /\ UNCHANGED <<inFan, stale, bp>>
         \/ /\ bp < MaxBP
            /\ bp' = bp + 1
            /\ inFan' = FALSE
            /\ stale' = (stale \/ subsHas)
            /\ UNCHANGED d2c
    ELSE UNCHANGED <<d2c, inFan, stale, bp>>

(* ChatSession.emit after `seq += 1`, with T the transcript at that seq. *)
Emit(f, T) ==
    /\ PushLog(f)
    /\ hist' = (f.seq :> T) @@ hist
    /\ Publish(f)

------------------------------------------------------------------------------
Init ==
    /\ dSeq = 0 /\ dT = <<>> /\ pend = None /\ dlog = <<>> /\ base = 0
    /\ hist = (0 :> <<>>) /\ loaded = TRUE
    /\ file = <<>> /\ pSeq = 0
    /\ inFan = FALSE /\ subsHas = FALSE /\ stale = FALSE /\ subPend = <<>>
    /\ c2d = <<>> /\ d2c = <<>>
    /\ cUp = FALSE /\ wantSub = TRUE /\ cHas = FALSE /\ cSeq = 0 /\ cT = <<>> /\ inbox = <<>>
    /\ tok = 0 /\ restarts = 0 /\ discs = 0 /\ bp = 0 /\ toggles = 0 /\ gap = FALSE

------------------------------------------------------------------------------
(* ---------------- agent -> ChatSession (AgentEvents callbacks) ---------- *)

(* ChatSession.upsert: flushDelta() first, then place + seq+1 + emit.  The   *)
(* flush is the separate FlushDelta step (enabled whenever pend /= None);    *)
(* requiring pend = None here only adds interleavings.                       *)
Upsert(i) ==
    /\ loaded /\ tok < MaxTok /\ pend = None
    /\ tok' = tok + 1
    /\ LET T == Put(dT, i, <<tok + 1>>) IN
       /\ dT' = T
       /\ dSeq' = dSeq + 1
       /\ Emit(Frame("item", dSeq + 1, i, <<tok + 1>>, <<>>), T)
    /\ UNCHANGED <<pend, loaded, file, pSeq, subsHas, subPend, c2d, clientVars, restarts, discs, toggles, gap>>

(* ChatSession.delta: coalesce into pendingDelta; a delta for another item  *)
(* flushes first (again: the FlushDelta step).  No seq is assigned yet.      *)
Delta(i) ==
    /\ loaded /\ tok < MaxTok
    /\ IF pend = None THEN TRUE ELSE pend.id = i
    /\ tok' = tok + 1
    /\ pend' = IF pend = None THEN [id |-> i, toks |-> <<tok + 1>>]
                              ELSE [id |-> i, toks |-> Append(pend.toks, tok + 1)]
    /\ UNCHANGED <<dSeq, dT, dlog, base, hist, loaded, file, pSeq, connVars, c2d, d2c,
                   clientVars, restarts, discs, bp, toggles, gap>>

(* ChatSession.flushDelta (timer, or called by upsert / setStatus /        *)
(* subscribe / persist).  A delta for an unknown item is dropped, no seq.  *)
FlushDelta ==
    /\ pend /= None
    /\ pend' = None
    /\ IF Has(dT, pend.id)
       THEN LET T == Extend(dT, pend.id, pend.toks) IN
            /\ dT' = T
            /\ dSeq' = dSeq + 1
            /\ Emit(Frame("delta", dSeq + 1, pend.id, pend.toks, <<>>), T)
       ELSE UNCHANGED <<dT, dSeq, dlog, base, hist, d2c, inFan, stale, bp>>
    /\ UNCHANGED <<loaded, file, pSeq, subsHas, subPend, c2d, clientVars, tok, restarts, discs, toggles, gap>>

(* ---------------- persistence timers ---------------------------------- *)

(* TranscriptFile.flush: every mutation touch()es the item, so after a flush *)
(* the file holds the in-memory transcript (pending delta not included).     *)
FileFlush ==
    /\ file /= dT
    /\ file' = dT
    /\ UNCHANGED <<dSeq, dT, pend, dlog, base, hist, loaded, pSeq, connVars, c2d, d2c, clientVars, bookVars>>

(* JsonWriter write of sessions.json (toRecord().seq).  Timing is free:      *)
(* SessionManager.changed schedules it 300 ms after a structure change or    *)
(* 1.3 s after activity.                                                     *)
PersistSeq ==
    /\ pSeq /= dSeq
    /\ pSeq' = dSeq
    /\ UNCHANGED <<dSeq, dT, pend, dlog, base, hist, loaded, file, connVars, c2d, d2c, clientVars, bookVars>>

(* ---------------- daemon restart ----------------------------------------- *)

(* SessionManager.load -> ChatSession.restore: seq = rec.seq + MARGIN, a new *)
(* EventLog(seq) (empty, baseSeq = seq), transcript from the file.           *)
(* With FixPersistOnLoad the jumped seq is written to sessions.json before   *)
(* the server accepts connections.                                           *)
NewEpoch(F, P) ==
    LET S == P + Margin IN
    /\ dSeq' = S /\ dT' = F /\ pend' = None /\ dlog' = <<>> /\ base' = S
    /\ hist' = (S :> F) /\ loaded' = FALSE
    /\ file' = F
    /\ pSeq' = IF FixPersistOnLoad THEN S ELSE P
    /\ inFan' = FALSE /\ subsHas' = FALSE /\ stale' = FALSE /\ subPend' = <<>>
    /\ c2d' = <<>> /\ d2c' = <<>> /\ cUp' = FALSE
    /\ restarts' = restarts + 1

(* Clean stop (SIGINT/SIGTERM -> Daemon.stop): sockets closed first, then   *)
(* manager.shutdown: persist() = flushDelta + transcript flush, then          *)
(* writer.flush() writes the current seq.                                     *)
CleanRestart ==
    /\ restarts < MaxRestarts
    /\ LET flushed == pend /= None /\ Has(dT, pend.id)
           T == IF flushed THEN Extend(dT, pend.id, pend.toks) ELSE dT
           S == IF flushed THEN dSeq + 1 ELSE dSeq
       IN NewEpoch(T, S)
    /\ UNCHANGED <<wantSub, cHas, cSeq, cT, inbox, tok, discs, bp, toggles, gap>>

(* Crash / kill -9 / power loss: whatever the timers had written survives. *)
CrashRestart ==
    /\ restarts < MaxRestarts
    /\ NewEpoch(file, pSeq)
    /\ UNCHANGED <<wantSub, cHas, cSeq, cT, inbox, tok, discs, bp, toggles, gap>>

(* ---------------- socket lifecycle -------------------------------------- *)

(* JS scheduling: once the transcript is loaded, the continuation of a        *)
(* pending subscribe is a microtask, so no other socket event (message,        *)
(* close, drain: all macrotasks) can run before it.  While a restored          *)
(* session's transcript is still being read from disk they can.                *)
Macrotask == loaded => subPend = <<>>

(* WsTransport connects, hello, `ready`; Client.onMessage('ready') re-sends  *)
(* `sub` for every live subscription with afterSeq = seqs.get(id), i.e. the   *)
(* seq of the last frame *rendered* (frames still in the inbox don't count). *)
SubMsg == [t |-> "sub", has |-> cHas, after |-> cSeq]

Connect ==
    /\ ~cUp
    /\ cUp' = TRUE
    /\ c2d' = IF wantSub THEN <<SubMsg>> ELSE <<>>
    /\ d2c' = <<>>
    /\ inFan' = FALSE /\ subsHas' = FALSE /\ stale' = FALSE /\ subPend' = <<>>
    /\ UNCHANGED <<daemonVars, wantSub, cHas, cSeq, cT, inbox, bookVars>>

(* Connection.onClose: unsubscribe everywhere.  In-flight frames are lost.  *)
(* A subscribe still awaiting the transcript load finishes on a closed       *)
(* connection whose sendFrame is false, so it cannot reach the client.       *)
Disconnect ==
    /\ cUp /\ discs < MaxDisc /\ Macrotask
    /\ discs' = discs + 1
    /\ cUp' = FALSE
    /\ c2d' = <<>> /\ d2c' = <<>>
    /\ inFan' = FALSE /\ subsHas' = FALSE /\ stale' = FALSE /\ subPend' = <<>>
    /\ UNCHANGED <<daemonVars, wantSub, cHas, cSeq, cT, inbox, tok, restarts, bp, toggles, gap>>

(* ---------------- daemon: Connection.route --------------------------------- *)

(* 'sub': s.unsubscribe(this); subs.add; stale.delete; s.subscribe(afterSeq) *)
(* runs up to its `await this.ensureLoaded()`.                               *)
RecvSub ==
    /\ cUp /\ Macrotask /\ c2d /= <<>> /\ Head(c2d).t = "sub"
    /\ c2d' = Tail(c2d)
    /\ inFan' = FALSE /\ subsHas' = TRUE /\ stale' = FALSE
    /\ subPend' = Append(subPend, [has |-> Head(c2d).has, after |-> Head(c2d).after])
    /\ UNCHANGED <<daemonVars, d2c, clientVars, bookVars>>

RecvUnsub ==
    /\ cUp /\ Macrotask /\ c2d /= <<>> /\ Head(c2d).t = "unsub"
    /\ c2d' = Tail(c2d)
    /\ inFan' = FALSE /\ subsHas' = FALSE /\ stale' = FALSE
    /\ UNCHANGED <<daemonVars, subPend, d2c, clientVars, bookVars>>

(* The rest of ChatSession.subscribe after the await (synchronous):          *)
(*   flushDelta (the FlushDelta step; required to have happened);            *)
(*   missed = afterSeq === undefined ? undefined : log.since(afterSeq, seq); *)
(*   send snapshot or each missed frame via fanout.sendTo, stop on failure;  *)
(*   fanout.add(sub).                                                        *)
SendAll(fs) ==
    \E k \in 0..Len(fs) :
        /\ (k < Len(fs)) => bp < MaxBP
        /\ d2c' = d2c \o SubSeq(fs, 1, k)
        /\ IF k = Len(fs)
           THEN /\ inFan' = TRUE /\ UNCHANGED <<stale, bp>>
           ELSE /\ bp' = bp + 1 /\ inFan' = FALSE /\ stale' = (stale \/ subsHas)

SubFinish ==
    /\ cUp /\ subPend /= <<>> /\ pend = None
    /\ subPend' = Tail(subPend)
    /\ loaded' = TRUE      \* the transcript load (if any) has completed
    /\ LET r == Head(subPend)
           missed == IF r.has THEN Since(r.after) ELSE None
       IN SendAll(IF missed = None THEN <<Frame("snap", dSeq, None, <<>>, dT)>> ELSE missed)
    /\ UNCHANGED <<dSeq, dT, pend, dlog, base, hist, file, pSeq,
                   subsHas, c2d, clientVars, tok, restarts, discs, toggles, gap>>

(* Bun 'drain' -> Connection.onDrain: for each stale session still in subs,  *)
(* s.subscribe(this) with no afterSeq (fresh snapshot).                      *)
Drain ==
    /\ cUp /\ Macrotask /\ stale
    /\ stale' = FALSE
    /\ subPend' = IF subsHas THEN Append(subPend, [has |-> FALSE, after |-> 0]) ELSE subPend
    /\ UNCHANGED <<daemonVars, inFan, subsHas, c2d, d2c, clientVars, bookVars>>

(* ---------------- phone ----------------------------------------------------- *)

Receive ==
    /\ cUp /\ d2c /= <<>>
    /\ d2c' = Tail(d2c)
    /\ inbox' = Append(inbox, Head(d2c))
    /\ UNCHANGED <<daemonVars, connVars, c2d, cUp, wantSub, cHas, cSeq, cT, bookVars>>

(* Client.flush: snapshot -> seqs.set + resetChat; item/delta only if       *)
(* fresh(seq) (seq > last), then upsertItem / appendDelta (appendDelta       *)
(* ignores unknown ids).                                                     *)
Apply ==
    /\ inbox /= <<>>
    /\ inbox' = Tail(inbox)
    /\ LET f == Head(inbox) IN
       IF f.kind = "snap"
       THEN /\ cT' = f.items /\ cSeq' = f.seq /\ cHas' = TRUE /\ UNCHANGED gap
       ELSE IF cHas /\ f.seq <= cSeq
       THEN UNCHANGED <<cT, cSeq, cHas, gap>>
       ELSE /\ cSeq' = f.seq /\ cHas' = TRUE
            /\ gap' = (gap \/ ~cHas \/ f.seq /= cSeq + 1)
            /\ cT' = IF f.kind = "item" THEN Put(cT, f.id, f.toks)
                     ELSE IF Has(cT, f.id) THEN Extend(cT, f.id, f.toks) ELSE cT
    /\ UNCHANGED <<daemonVars, connVars, c2d, d2c, cUp, wantSub, tok, restarts, discs, bp, toggles>>

(* The chat screen unmounts (ref count 0 -> 'unsub'; chat state and seq are *)
(* kept) or mounts again ('sub' with afterSeq).  Sent only while connected; *)
(* queued sub/unsub are dropped and re-derived on 'ready'.                    *)
Unsub ==
    /\ wantSub /\ toggles < MaxToggle
    /\ wantSub' = FALSE /\ toggles' = toggles + 1
    /\ c2d' = IF cUp THEN Append(c2d, [t |-> "unsub", has |-> FALSE, after |-> 0]) ELSE c2d
    /\ UNCHANGED <<daemonVars, connVars, d2c, cUp, cHas, cSeq, cT, inbox, tok, restarts, discs, bp, gap>>

Resub ==
    /\ ~wantSub /\ toggles < MaxToggle
    /\ wantSub' = TRUE /\ toggles' = toggles + 1
    /\ c2d' = IF cUp THEN Append(c2d, SubMsg) ELSE c2d
    /\ UNCHANGED <<daemonVars, connVars, d2c, cUp, cHas, cSeq, cT, inbox, tok, restarts, discs, bp, gap>>

------------------------------------------------------------------------------
Next ==
    \/ \E i \in Items : Upsert(i) \/ Delta(i)
    \/ FlushDelta \/ FileFlush \/ PersistSeq
    \/ CleanRestart \/ CrashRestart
    \/ Connect \/ Disconnect
    \/ RecvSub \/ RecvUnsub \/ SubFinish \/ Drain
    \/ Receive \/ Apply \/ Unsub \/ Resub

Fairness ==
    /\ WF_vars(FlushDelta)
    /\ WF_vars(Connect)
    /\ WF_vars(RecvSub) /\ WF_vars(RecvUnsub) /\ WF_vars(SubFinish) /\ WF_vars(Drain)
    /\ WF_vars(Receive) /\ WF_vars(Apply)

Spec == Init /\ [][Next]_vars /\ Fairness

------------------------------------------------------------------------------
(* ---------------- properties -------------------------------------------- *)

TypeOK ==
    /\ dSeq \in Nat /\ pSeq \in Nat /\ base \in Nat /\ cSeq \in Nat
    /\ cHas \in BOOLEAN /\ wantSub \in BOOLEAN /\ cUp \in BOOLEAN
    /\ Len(dlog) <= LogMax

(* The heart of `afterSeq`: a seq the phone holds names exactly one daemon   *)
(* state.  If the phone's rendered seq n is a seq of the current daemon      *)
(* epoch, its transcript is the daemon's transcript at n.  (So no lost,      *)
(* duplicated or reordered delta, no stale item, and an `afterSeq` resume    *)
(* can never be applied on top of the wrong base.)                           *)
CaughtUpMeansEqual ==
    (cHas /\ cSeq \in DOMAIN hist) => cT = hist[cSeq]

(* The phone never applies an incremental frame across a hole in seq.  *)
NoGap == ~gap

(* Every frame on the wire / in the inbox that is incremental refers to a seq *)
(* the daemon really emitted with that content (sanity of the model).        *)
LogConsistent ==
    \A k \in 1..Len(dlog) : dlog[k].seq > base /\ dlog[k].seq <= dSeq

(* The connection is never in the session's fanout without being in its    *)
(* `subs` (a subscription that outlives the client's unsub).               *)
NoGhostSubscriber == inFan => subsHas

Converged == (cUp /\ wantSub) => (cHas /\ cSeq = dSeq /\ cT = dT)

(* Liveness: once the environment stops disturbing (finite budgets), a       *)
(* connected, subscribed phone converges to the daemon's transcript.         *)
EventuallyConverges == <>[]Converged

=============================================================================
