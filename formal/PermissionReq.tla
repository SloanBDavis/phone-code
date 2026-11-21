-------------------------- MODULE PermissionReq --------------------------
(***************************************************************************)
(* Agent permission / question requests answered from several phones, with *)
(* interrupts, agent crashes and daemon restarts.                          *)
(*                                                                         *)
(* Code being modelled (packages/daemon/src):                               *)
(*   sessions/chat.ts     ChatSession.resolvePermission / answerQuestion    *)
(*                        (forward to the adapter), interrupt, send ->      *)
(*                        deliver (setStatus('running') then agent.send),   *)
(*                        setStatus, upsert, restore (running|waiting ->    *)
(*                        idle)                                             *)
(*   sessions/transcript-file.ts  settle(): pending -> cancelled on load    *)
(*   ws-client.ts         route 'chat.permission' / 'chat.answer' /         *)
(*                        'chat.interrupt' / 'chat.send'                    *)
(*   agents/claude.ts     (reference adapter, read only) onControlRequest,  *)
(*                        control_cancel_request, settle, resolvePermission,*)
(*                        answerQuestion, interrupt (cancelAllPending),     *)
(*                        onResult, onExit, send, launch                    *)
(*   agents/shared/common.ts  StatusTracker.compute / emit (dedups by last) *)
(*                                                                         *)
(* A question is the same as a permission here (answerQuestion has the     *)
(* same shape: pending map lookup, settle, respond), so one kind is        *)
(* modelled.  Each request id is used once (the CLI's request_id /          *)
(* tool_use_id).                                                           *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Reqs, Clients, None,
    MaxSends, MaxRestarts, MaxCrashes,
    FixDeliverStatus    \* deliver() does not overwrite 'waiting' with 'running'

Status == {"idle", "running", "waiting", "error"}

VARIABLES
    item,         \* [Reqs -> {"none","pending","allowed","denied","cancelled"}]  core transcript
    info,         \* SessionInfo.status in the core
    agentUp,      \* ChatSession.agent is set (adapter started)
    proc,         \* the CLI process is running
    apending,     \* adapter's pending map
    turns,        \* adapter turnsQueued
    crashed,      \* StatusTracker.crashed
    last,         \* StatusTracker.last (None = nothing emitted yet)
    asked,        \* requests the CLI is blocked on (awaiting control_response)
    used,         \* request ids the CLI has issued
    resp,         \* [Reqs -> Nat] control_responses the CLI received
    respLate,     \* a response reached the CLI for a request it no longer awaited
    view,         \* [Clients -> [Reqs -> BOOLEAN]]  phone shows the request as pending
    msgs,         \* chat.permission frames in flight: set of [c, r, allow]
    delivers,     \* chat.send messages whose deliver() has not run yet
    sends, restarts, crashes,
    fwdSettled,   \* core forwarded a decision for an item that is not pending
    reopened      \* a settled item became pending again

vars == <<item, info, agentUp, proc, apending, turns, crashed, last, asked, used, resp, respLate,
          view, msgs, delivers, sends, restarts, crashes, fwdSettled, reopened>>

Init ==
    /\ item = [r \in Reqs |-> "none"] /\ info = "idle"
    /\ agentUp = FALSE /\ proc = FALSE /\ apending = {} /\ turns = 0 /\ crashed = FALSE /\ last = None
    /\ asked = {} /\ used = {} /\ resp = [r \in Reqs |-> 0] /\ respLate = FALSE
    /\ view = [c \in Clients |-> [r \in Reqs |-> FALSE]] /\ msgs = {} /\ delivers = 0
    /\ sends = 0 /\ restarts = 0 /\ crashes = 0
    /\ fwdSettled = FALSE /\ reopened = FALSE

------------------------------------------------------------------------------
(* StatusTracker.compute with the adapter's next state. *)
Compute(cr, pend, active) ==
    IF cr THEN "error" ELSE IF pend /= {} THEN "waiting" ELSE IF active THEN "running" ELSE "idle"

(* StatusTracker.emit -> events.status -> ChatSession.setStatus (dedups by value). *)
Emit(cr, pend, active) ==
    LET s == Compute(cr, pend, active) IN
    IF s /= last THEN last' = s /\ info' = s ELSE UNCHANGED <<last, info>>

(* claude.ts settle(itemId, status): pending.delete, upsert the new status. *)
SettleAll(rs, st) == [r \in Reqs |-> IF r \in rs THEN st ELSE item[r]]

------------------------------------------------------------------------------
(* chat.send: the UserItem is added, deliver() runs once ensureAgent resolves. *)
Send ==
    /\ sends < MaxSends
    /\ sends' = sends + 1 /\ delivers' = delivers + 1
    /\ UNCHANGED <<item, info, agentUp, proc, apending, turns, crashed, last, asked, used, resp,
                   respLate, view, msgs, restarts, crashes, fwdSettled, reopened>>

(* ChatSession.deliver: setStatus('running'); agent.send(): (re)launch if the *)
(* process is gone (crashed = false), turnsQueued++, turnActive, emit.        *)
Deliver ==
    /\ delivers > 0
    /\ delivers' = delivers - 1
    /\ agentUp' = TRUE /\ proc' = TRUE /\ crashed' = FALSE
    /\ turns' = turns + 1
    /\ LET coreSet == IF FixDeliverStatus /\ info = "waiting" THEN info ELSE "running"
           s == Compute(FALSE, apending, TRUE)
       IN IF s /= last THEN last' = s /\ info' = s ELSE last' = last /\ info' = coreSet
    /\ UNCHANGED <<item, apending, asked, used, resp, respLate, view, msgs, sends, restarts,
                   crashes, fwdSettled, reopened>>

(* The CLI asks (control_request can_use_tool) during a turn:               *)
(* onControlRequest: pending.set, upsert pending item, emit.                *)
Ask(r) ==
    /\ proc /\ turns > 0 /\ r \notin used
    /\ used' = used \cup {r} /\ asked' = asked \cup {r}
    /\ apending' = apending \cup {r}
    /\ item' = [item EXCEPT ![r] = "pending"]
    /\ reopened' = (reopened \/ item[r] /= "none")
    /\ Emit(crashed, apending \cup {r}, TRUE)
    /\ UNCHANGED <<agentUp, proc, turns, crashed, resp, respLate, view, msgs, delivers, sends,
                   restarts, crashes, fwdSettled>>

(* control_cancel_request: settle(itemId, 'cancelled'). *)
CliCancel(r) ==
    /\ proc /\ r \in asked
    /\ asked' = asked \ {r}
    /\ IF r \in apending
       THEN /\ apending' = apending \ {r}
            /\ item' = [item EXCEPT ![r] = "cancelled"]
            /\ Emit(crashed, apending \ {r}, turns > 0)
       ELSE UNCHANGED <<apending, item, last, info>>
    /\ UNCHANGED <<agentUp, proc, turns, crashed, used, resp, respLate, view, msgs, delivers,
                   sends, restarts, crashes, fwdSettled, reopened>>

(* A phone renders what it has received so far (any subset of updates may   *)
(* still be in flight, so its view can be stale).                           *)
See(c, r) ==
    /\ view[c][r] /= (item[r] = "pending")
    /\ view' = [view EXCEPT ![c][r] = (item[r] = "pending")]
    /\ UNCHANGED <<item, info, agentUp, proc, apending, turns, crashed, last, asked, used, resp,
                   respLate, msgs, delivers, sends, restarts, crashes, fwdSettled, reopened>>

(* The user taps Allow / Deny on a card the phone shows as pending. *)
Tap(c, r, allow) ==
    /\ view[c][r]
    /\ msgs' = msgs \cup {[c |-> c, r |-> r, allow |-> allow]}
    /\ UNCHANGED <<item, info, agentUp, proc, apending, turns, crashed, last, asked, used, resp,
                   respLate, view, delivers, sends, restarts, crashes, fwdSettled, reopened>>

(* route 'chat.permission' -> ChatSession.resolvePermission ->              *)
(* agent?.resolvePermission (no check in the core) -> claude.ts:            *)
(* pending.get; if found: settle(allowed|denied) + respond(request_id).     *)
Decide(m) ==
    /\ m \in msgs
    /\ msgs' = msgs \ {m}
    /\ fwdSettled' = (fwdSettled \/ (agentUp /\ item[m.r] /= "pending"))
    /\ IF agentUp /\ m.r \in apending
       THEN /\ apending' = apending \ {m.r}
            /\ item' = [item EXCEPT ![m.r] = IF m.allow THEN "allowed" ELSE "denied"]
            /\ resp' = [resp EXCEPT ![m.r] = @ + 1]
            /\ respLate' = (respLate \/ m.r \notin asked)
            /\ asked' = asked \ {m.r}
            /\ Emit(crashed, apending \ {m.r}, turns > 0)
       ELSE UNCHANGED <<apending, item, resp, respLate, asked, last, info>>
    /\ UNCHANGED <<agentUp, proc, turns, crashed, used, view, delivers, sends, restarts, crashes,
                   reopened>>

(* chat.interrupt -> claude.ts interrupt: only with a process and a turn:   *)
(* cancelAllPending, then the interrupt control request (the CLI abandons    *)
(* the outstanding permission prompts).                                      *)
Interrupt ==
    /\ agentUp /\ proc /\ turns > 0
    /\ apending' = {}
    /\ item' = SettleAll(apending, "cancelled")
    /\ asked' = {}
    /\ Emit(crashed, {}, TRUE)
    /\ UNCHANGED <<agentUp, proc, turns, crashed, used, resp, respLate, view, msgs, delivers, sends,
                   restarts, crashes, fwdSettled, reopened>>

(* The CLI finishes a turn (it cannot while blocked on a prompt):           *)
(* onResult: endTurn, cancelAllPending, turnsQueued -= 1, emit.             *)
Result ==
    /\ proc /\ turns > 0 /\ asked = {}
    /\ turns' = turns - 1
    /\ apending' = {}
    /\ item' = SettleAll(apending, "cancelled")
    /\ Emit(crashed, {}, turns - 1 > 0)
    /\ UNCHANGED <<agentUp, proc, crashed, asked, used, resp, respLate, view, msgs, delivers, sends,
                   restarts, crashes, fwdSettled, reopened>>

(* The CLI dies: onExit: cancelAllPending, turnsQueued = 0, crashed, emit.  *)
AgentCrash ==
    /\ proc /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ proc' = FALSE /\ turns' = 0 /\ crashed' = TRUE /\ asked' = {}
    /\ apending' = {}
    /\ item' = SettleAll(apending, "cancelled")
    /\ Emit(TRUE, {}, FALSE)
    /\ UNCHANGED <<agentUp, used, resp, respLate, view, msgs, delivers, sends, restarts,
                   fwdSettled, reopened>>

(* Daemon restart (clean or crash): sockets and in-flight frames gone, the  *)
(* agent process killed; ChatSession.restore + transcript settle():          *)
(* pending -> cancelled, running|waiting -> idle; no adapter until a send.  *)
Restart ==
    /\ restarts < MaxRestarts
    /\ restarts' = restarts + 1
    /\ item' = [r \in Reqs |-> IF item[r] = "pending" THEN "cancelled" ELSE item[r]]
    /\ info' = IF info \in {"running", "waiting"} THEN "idle" ELSE info
    /\ agentUp' = FALSE /\ proc' = FALSE /\ apending' = {} /\ turns' = 0 /\ crashed' = FALSE
    /\ last' = None /\ asked' = {} /\ msgs' = {} /\ delivers' = 0
    /\ UNCHANGED <<used, resp, respLate, view, sends, crashes, fwdSettled, reopened>>

Next ==
    \/ Send \/ Deliver \/ Interrupt \/ Result \/ AgentCrash \/ Restart
    \/ \E r \in Reqs : Ask(r) \/ CliCancel(r)
    \/ \E c \in Clients, r \in Reqs : See(c, r) \/ Tap(c, r, TRUE) \/ Tap(c, r, FALSE)
    \/ \E m \in msgs : Decide(m)

Spec == Init /\ [][Next]_vars

------------------------------------------------------------------------------
TypeOK ==
    /\ info \in Status
    /\ apending \subseteq Reqs /\ asked \subseteq Reqs
    /\ \A r \in Reqs : item[r] \in {"none", "pending", "allowed", "denied", "cancelled"}

(* Each request is resolved at most once: the CLI gets at most one answer,  *)
(* and a settled card never becomes pending again.                          *)
AtMostOnce == (\A r \in Reqs : resp[r] <= 1) /\ ~reopened

(* No answer reaches the agent for a request that was cancelled (by the CLI, *)
(* an interrupt, the end of the turn, a crash or a restart).                *)
NoAnswerAfterCancel == ~respLate

(* The transcript and the adapter agree on what is pending. *)
CoreMatchesAdapter == agentUp => \A r \in Reqs : (item[r] = "pending") <=> (r \in apending)

(* The session shows `waiting` exactly while some request is pending. *)
WaitingIffPending == (info = "waiting") <=> (\E r \in Reqs : item[r] = "pending")

(* Interface: the core never hands the adapter a decision for a card that is *)
(* not pending (stricter than NoAnswerAfterCancel: adapters filter today).   *)
CoreForwardsOnlyPending == ~fwdSettled

=============================================================================
