--------------------------- MODULE PairingAuth ---------------------------
(***************************************************************************)
(* Pairing codes, handoff codes, device tokens, revocation and the hello    *)
(* deadline, as implemented.                                                *)
(*                                                                         *)
(* Code being modelled (packages/daemon/src):                               *)
(*   auth/pairing.ts   PairingCodes.create (MAX_ACTIVE_CODES eviction),     *)
(*                     addFixed (PHONECODE_PAIR_CODE), redeem (rate limit   *)
(*                     on the typed form only, prune, single use),          *)
(*                     isRateLimited / recordFailure, forgetDevices         *)
(*   auth/devices.ts   DeviceStore.add (parent) / authenticate / revoke     *)
(*                     (cascade to descendants), JsonWriter persistence     *)
(*                     (500 ms debounce), load                              *)
(*   http/server.ts    pair(), handoff() (Bearer token), control revoke     *)
(*   daemon.ts         startDaemon order (devices loaded, server listening, *)
(*                     control.json written last), control.revoke ->        *)
(*                     devices.revoke + registry.closeDevice, stop()        *)
(*   cli.ts            revokeCommand: control endpoint, or offline edit of  *)
(*                     devices.json when the control endpoint is            *)
(*                     unreachable                                          *)
(*   ws-client.ts      Connection: hello timer, hello(), onMessage ->       *)
(*                     dispatch (checks closed), rpc(), close/onClose,      *)
(*                     ConnectionRegistry.closeDevice                       *)
(*                                                                         *)
(* Abstractions                                                            *)
(*  - Codes and tokens are unguessable: a guess never matches; a client     *)
(*    presents a code that was issued or a token that was minted.           *)
(*  - Time: TTL expiry, the rate-limit minute and the hello deadline are    *)
(*    actions that may happen at any moment.                                *)
(*  - The rate limit is modelled with small limits (FailIp / FailGlobal     *)
(*    stand for 8 / 40) and one window at a time. IPs are the rate-limit    *)
(*    keys (http/server.ts clientKey). Only the typed form of a pairing     *)
(*    code is limited; the link form (QR, handoff) never is.                *)
(*  - "Work" is an rpc whose handler awaits I/O (session.create's           *)
(*    assertDirectory, chat.send on a not yet loaded transcript, ...).      *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    Codes, Devs, Conns, IPs,
    Fixed,              \* model value: the PHONECODE_PAIR_CODE code
    HasFixed,           \* PHONECODE_PAIR_CODE set?
    None,
    MaxActive,          \* MAX_ACTIVE_CODES
    FailIp, FailGlobal, \* FAILS_PER_IP_PER_MIN, FAILS_GLOBAL_PER_MIN
    MaxRestarts,
    FixHandoffRevoke,   \* revoke also drops handoff codes minted by the device
    FixDurableRevoke,   \* control revoke answers only after devices.json is written
    FixOfflineRevoke,   \* offline `phonecode revoke` refuses while a daemon process is alive
    FixCascade          \* revoking a device also revokes the devices paired through it

VARIABLES
    phase,       \* "down" | "starting" (devices loaded, HTTP+ws served, no control.json) | "up"
    mem,         \* DeviceStore in memory (set of device ids)
    persisted,   \* devices.json
    minted,      \* every device id ever minted (its token exists on some phone)
    codeSt,      \* [Codes -> {"unused","active","expired","gone"}]
    queue,       \* PairingCodes.codes in insertion order (Codes and Fixed)
    issuer,      \* [Codes -> Devs \cup {None}]: device that minted a handoff code
    via,         \* [Devs -> Codes \cup {Fixed, None}]: code a device was paired with
    parent,      \* [Devs -> Devs \cup {None}]: DeviceRecord.parent (issuer of its handoff code)
    orphan,      \* [Devs -> BOOLEAN]: paired with a handoff code of an already revoked device
    revoked,     \* revocations the CLI reported as done
    conn, cdev,  \* [Conns -> {"none","pre","authed","closed"}], [Conns -> Devs \cup {None}]
    work,        \* in-flight rpc handlers: set of <<conn, dev>>
    fails, gfails,
    restarts,
    actedAfterRevoke, effectAfterRevoke

vars == <<phase, mem, persisted, minted, codeSt, queue, issuer, via, parent, orphan, revoked,
          conn, cdev, work, fails, gfails, restarts, actedAfterRevoke, effectAfterRevoke>>

Served == phase /= "down"

Init ==
    /\ phase = "down" /\ mem = {} /\ persisted = {} /\ minted = {}
    /\ codeSt = [c \in Codes |-> "unused"] /\ queue = <<>>
    /\ issuer = [c \in Codes |-> None]
    /\ via = [d \in Devs |-> None] /\ parent = [d \in Devs |-> None]
    /\ orphan = [d \in Devs |-> FALSE]
    /\ revoked = {}
    /\ conn = [k \in Conns |-> "none"] /\ cdev = [k \in Conns |-> None]
    /\ work = {}
    /\ fails = [i \in IPs |-> 0] /\ gfails = 0
    /\ restarts = 0
    /\ actedAfterRevoke = FALSE /\ effectAfterRevoke = FALSE

------------------------------------------------------------------------------
Remove(s, x) == SelectSeq(s, LAMBDA y : y /= x)
InQ(x) == \E i \in 1..Len(queue) : queue[i] = x

(* PairingCodes.prune: drop expired codes. *)
Pruned == SelectSeq(queue, LAMBDA y : IF y = Fixed THEN TRUE ELSE codeSt[y] /= "expired")
PruneSt == [c \in Codes |-> IF codeSt[c] = "expired" THEN "gone" ELSE codeSt[c]]

(* PairingCodes.create(kind): prune, evict the oldest while >= MAX, push. *)
Create(c, iss) ==
    /\ codeSt[c] = "unused"
    /\ LET q0 == Pruned
           q1 == IF Len(q0) >= MaxActive THEN SubSeq(q0, Len(q0) - MaxActive + 2, Len(q0)) ELSE q0
           evicted == {q0[i] : i \in 1..(Len(q0) - Len(q1))}
       IN /\ queue' = Append(q1, c)
          /\ codeSt' = [x \in Codes |-> IF x = c THEN "active"
                                         ELSE IF x \in evicted THEN "gone" ELSE PruneSt[x]]
    /\ issuer' = [issuer EXCEPT ![c] = iss]

CloseConns(R) == [k \in Conns |-> IF cdev[k] \in R /\ conn[k] \in {"pre", "authed"} THEN "closed" ELSE conn[k]]

(* DeviceStore.revoke: the device and, with the cascade, every device whose *)
(* parent chain reaches it.                                                 *)
RECURSIVE Close(_)
Close(S) == LET T == S \cup {e \in minted : parent[e] \in S} IN IF T = S THEN S ELSE Close(T)
Revokes(d) == IF FixCascade THEN Close({d}) ELSE {d}

RECURSIVE Ancestors(_)
Ancestors(e) == IF parent[e] = None THEN {} ELSE {parent[e]} \cup Ancestors(parent[e])

------------------------------------------------------------------------------
(* ---------------- daemon process lifecycle ------------------------------ *)

(* startDaemon: DeviceStore.load, SessionManager.load, startServer (HTTP and *)
(* ws now served), tunnel / URL, pairing code, then control.json.            *)
Start ==
    /\ phase = "down" /\ restarts < MaxRestarts
    /\ restarts' = restarts + 1
    /\ phase' = "starting"
    /\ mem' = persisted
    /\ codeSt' = [c \in Codes |-> IF codeSt[c] = "unused" THEN "unused" ELSE "gone"]
    /\ queue' = <<>>
    /\ fails' = [i \in IPs |-> 0] /\ gfails' = 0
    /\ UNCHANGED <<persisted, minted, issuer, via, parent, orphan, revoked, conn, cdev, work,
                   actedAfterRevoke, effectAfterRevoke>>

(* Pairing code shown in the banner (or the fixed test code), control.json. *)
Ready ==
    /\ phase = "starting"
    /\ phase' = "up"
    /\ IF HasFixed
       THEN /\ queue' = Append(queue, Fixed) /\ UNCHANGED <<codeSt, issuer>>
       ELSE \E c \in Codes : Create(c, None)
    /\ UNCHANGED <<mem, persisted, minted, via, parent, orphan, revoked, conn, cdev, work, fails, gfails,
                   restarts, actedAfterRevoke, effectAfterRevoke>>

(* Crash: memory gone, sockets gone; devices.json is what JsonWriter wrote. *)
Crash ==
    /\ Served
    /\ phase' = "down"
    /\ conn' = [k \in Conns |-> IF conn[k] = "none" THEN "none" ELSE "closed"]
    /\ work' = {}
    /\ UNCHANGED <<mem, persisted, minted, codeSt, queue, issuer, via, parent, orphan, revoked, cdev,
                   fails, gfails, restarts, actedAfterRevoke, effectAfterRevoke>>

(* Daemon.stop: closeAll, ..., devices.flush(). *)
Stop ==
    /\ Served
    /\ phase' = "down"
    /\ persisted' = mem
    /\ conn' = [k \in Conns |-> IF conn[k] = "none" THEN "none" ELSE "closed"]
    /\ work' = {}
    /\ UNCHANGED <<mem, minted, codeSt, queue, issuer, via, parent, orphan, revoked, cdev,
                   fails, gfails, restarts, actedAfterRevoke, effectAfterRevoke>>

(* JsonWriter timer for devices.json (DeviceStore.add / touch / revoke schedule it). *)
WriteDevices ==
    /\ Served /\ persisted /= mem
    /\ persisted' = mem
    /\ UNCHANGED <<phase, mem, minted, codeSt, queue, issuer, via, parent, orphan, revoked, conn, cdev,
                   work, fails, gfails, restarts, actedAfterRevoke, effectAfterRevoke>>

(* ---------------- codes --------------------------------------------------- *)

(* `phonecode pair` (control) / Enter in the terminal: a fresh pairing code. *)
NewPairCode ==
    /\ phase = "up"
    /\ \E c \in Codes : Create(c, None)
    /\ UNCHANGED <<phase, mem, persisted, minted, via, parent, orphan, revoked, conn, cdev, work,
                   fails, gfails, restarts, actedAfterRevoke, effectAfterRevoke>>

(* POST /api/handoff with Authorization: Bearer <token of d>. *)
Handoff(d) ==
    /\ Served /\ d \in minted /\ d \in mem
    /\ \E c \in Codes : Create(c, d)
    /\ UNCHANGED <<phase, mem, persisted, minted, via, parent, orphan, revoked, conn, cdev, work,
                   fails, gfails, restarts, actedAfterRevoke, effectAfterRevoke>>

(* PAIR_CODE_TTL_MS elapses. *)
Expire(c) ==
    /\ codeSt[c] = "active"
    /\ codeSt' = [codeSt EXCEPT ![c] = "expired"]
    /\ UNCHANGED <<phase, mem, persisted, minted, queue, issuer, via, parent, orphan, revoked, conn, cdev,
                   work, fails, gfails, restarts, actedAfterRevoke, effectAfterRevoke>>

RateLimited(ip) == fails[ip] >= FailIp \/ gfails >= FailGlobal

(* POST /api/pair {code}: PairingCodes.redeem then DeviceStore.add.         *)
(* redeem: rate-limit check (typed form only), prune, constant-time match,  *)
(* delete if not reusable.  All synchronous: two requests cannot interleave *)
(* inside it.  A handoff code has only the link form; the fixed test code   *)
(* only the typed one.  The new device's parent is the code's issuer.       *)
Pair(c, ip, form) ==
    /\ Served
    /\ form = "typed" => ~RateLimited(ip)
    /\ IF c = Fixed THEN form = "typed" ELSE (issuer[c] /= None => form = "link")
    /\ IF c = Fixed THEN TRUE ELSE codeSt[c] \in {"active", "expired"}  \* the client holds an issued code
    /\ LET q == Pruned IN
       \E i \in 1..Len(q) : q[i] = c                         \* still there after prune: match
    /\ \E e \in Devs :
        /\ e \notin minted
        /\ minted' = minted \cup {e}
        /\ mem' = mem \cup {e}
        /\ via' = [via EXCEPT ![e] = c]
        /\ parent' = [parent EXCEPT ![e] = IF c = Fixed THEN None ELSE issuer[c]]
        /\ orphan' = [orphan EXCEPT ![e] = IF c = Fixed THEN FALSE ELSE issuer[c] \in revoked]
    /\ queue' = IF c = Fixed THEN Pruned ELSE Remove(Pruned, c)
    /\ codeSt' = IF c = Fixed THEN PruneSt ELSE [PruneSt EXCEPT ![c] = "gone"]
    /\ UNCHANGED <<phase, persisted, issuer, revoked, conn, cdev, work, fails, gfails, restarts,
                   actedAfterRevoke, effectAfterRevoke>>

(* POST /api/pair with a wrong or expired code. *)
BadPair(ip) ==
    /\ Served /\ ~RateLimited(ip)
    /\ fails' = [fails EXCEPT ![ip] = @ + 1] /\ gfails' = gfails + 1
    /\ queue' = Pruned /\ codeSt' = PruneSt
    /\ UNCHANGED <<phase, mem, persisted, minted, issuer, via, parent, orphan, revoked, conn, cdev, work,
                   restarts, actedAfterRevoke, effectAfterRevoke>>

(* The 60 s window slides past all recorded failures. *)
MinutePasses ==
    /\ gfails > 0
    /\ fails' = [i \in IPs |-> 0] /\ gfails' = 0
    /\ UNCHANGED <<phase, mem, persisted, minted, codeSt, queue, issuer, via, parent, orphan, revoked,
                   conn, cdev, work, restarts, actedAfterRevoke, effectAfterRevoke>>

(* ---------------- websocket ------------------------------------------------ *)

Open(k) ==
    /\ Served /\ conn[k] = "none"
    /\ conn' = [conn EXCEPT ![k] = "pre"]
    /\ UNCHANGED <<phase, mem, persisted, minted, codeSt, queue, issuer, via, parent, orphan, revoked, cdev,
                   work, fails, gfails, restarts, actedAfterRevoke, effectAfterRevoke>>

(* Connection.hello with the token of device d (any token a phone holds).  *)
(* DeviceStore.authenticate checks the in-memory store.                    *)
Hello(k, d) ==
    /\ Served /\ conn[k] = "pre" /\ d \in minted
    /\ IF d \in mem
       THEN conn' = [conn EXCEPT ![k] = "authed"] /\ cdev' = [cdev EXCEPT ![k] = d]
       ELSE conn' = [conn EXCEPT ![k] = "closed"] /\ UNCHANGED cdev
    /\ UNCHANGED <<phase, mem, persisted, minted, codeSt, queue, issuer, via, parent, orphan, revoked,
                   work, fails, gfails, restarts, actedAfterRevoke, effectAfterRevoke>>

(* Any non-hello frame before hello, a bad token, a wrong version, or       *)
(* HELLO_TIMEOUT_MS: fail('unauthorized') + close.                          *)
PreAuthFail(k) ==
    /\ conn[k] = "pre"
    /\ conn' = [conn EXCEPT ![k] = "closed"]
    /\ UNCHANGED <<phase, mem, persisted, minted, codeSt, queue, issuer, via, parent, orphan, revoked, cdev,
                   work, fails, gfails, restarts, actedAfterRevoke, effectAfterRevoke>>

(* onMessage -> dispatch (returns if closed) -> route.  An rpc whose        *)
(* handler awaits I/O leaves work in flight.                                *)
Message(k) ==
    /\ Served /\ conn[k] = "authed"
    /\ actedAfterRevoke' = (actedAfterRevoke \/ cdev[k] \in revoked)
    /\ \/ UNCHANGED work
       \/ work' = work \cup {<<k, cdev[k]>>}
    /\ UNCHANGED <<phase, mem, persisted, minted, codeSt, queue, issuer, via, parent, orphan, revoked,
                   conn, cdev, fails, gfails, restarts, effectAfterRevoke>>

(* The awaited I/O returns and the handler performs its effect (create /    *)
(* delete a session, hand a message to the agent).  Nothing checks the      *)
(* connection again: only the reply is suppressed when closed.             *)
WorkDone(w) ==
    /\ w \in work
    /\ work' = work \ {w}
    /\ effectAfterRevoke' = (effectAfterRevoke \/ w[2] \in revoked)
    /\ UNCHANGED <<phase, mem, persisted, minted, codeSt, queue, issuer, via, parent, orphan, revoked,
                   conn, cdev, fails, gfails, restarts, actedAfterRevoke>>

ClientClose(k) ==
    /\ conn[k] \in {"pre", "authed"}
    /\ conn' = [conn EXCEPT ![k] = "closed"]
    /\ UNCHANGED <<phase, mem, persisted, minted, codeSt, queue, issuer, via, parent, orphan, revoked, cdev,
                   work, fails, gfails, restarts, actedAfterRevoke, effectAfterRevoke>>

(* ---------------- revocation --------------------------------------------- *)

(* PairingCodes.forgetDevices: drop the handoff codes minted by revoked devices. *)
DropHandoffs(R) ==
    IF FixHandoffRevoke
    THEN /\ queue' = SelectSeq(queue, LAMBDA y : IF y = Fixed THEN TRUE ELSE issuer[y] \notin R)
         /\ codeSt' = [c \in Codes |-> IF issuer[c] \in R /\ codeSt[c] \in {"active", "expired"}
                                         THEN "gone" ELSE codeSt[c]]
    ELSE UNCHANGED <<queue, codeSt>>

(* `phonecode revoke` -> POST /_control/revoke -> control.revoke (and        *)
(* /api/unpair): devices.revoke (the device and, with the cascade, its       *)
(* descendants; JsonWriter.schedule) + registry.closeDevice for each, then   *)
(* the CLI prints "Revoked".                                                 *)
RevokeViaControl(d) ==
    /\ phase = "up" /\ d \in mem
    /\ LET R == Revokes(d) \cap mem IN
       /\ mem' = mem \ R
       /\ conn' = CloseConns(R)
       /\ DropHandoffs(R)
       /\ persisted' = IF FixDurableRevoke THEN mem \ R ELSE persisted
       /\ revoked' = revoked \cup R
    /\ UNCHANGED <<phase, minted, issuer, via, parent, orphan, cdev, work, fails, gfails, restarts,
                   actedAfterRevoke, effectAfterRevoke>>

(* ControlClient.connect failed (no control.json, or it does not answer):   *)
(* the CLI edits devices.json itself (DeviceStore.revoke, same cascade) and *)
(* prints "Revoked".                                                        *)
RevokeOffline(d) ==
    /\ IF FixOfflineRevoke THEN phase = "down" ELSE phase \in {"down", "starting"}
    /\ d \in persisted
    /\ LET R == Revokes(d) \cap persisted IN
       /\ persisted' = persisted \ R
       /\ revoked' = revoked \cup R
    /\ UNCHANGED <<phase, mem, minted, codeSt, queue, issuer, via, parent, orphan, conn, cdev, work,
                   fails, gfails, restarts, actedAfterRevoke, effectAfterRevoke>>

------------------------------------------------------------------------------
Next ==
    \/ Start \/ Ready \/ Crash \/ Stop \/ WriteDevices
    \/ NewPairCode \/ MinutePasses
    \/ \E d \in Devs : Handoff(d) \/ RevokeViaControl(d) \/ RevokeOffline(d)
    \/ \E c \in Codes : Expire(c)
    \/ \E c \in Codes \cup {Fixed}, ip \in IPs, form \in {"typed", "link"} : Pair(c, ip, form)
    \/ \E ip \in IPs : BadPair(ip)
    \/ \E k \in Conns : Open(k) \/ PreAuthFail(k) \/ Message(k) \/ ClientClose(k)
                        \/ \E d \in Devs : Hello(k, d)
    \/ \E w \in work : WorkDone(w)

Spec == Init /\ [][Next]_vars /\ \A k \in Conns : WF_vars(PreAuthFail(k))

(* Code, device, socket and IP slots are interchangeable (safety runs only). *)
Symmetry == Permutations(Codes) \cup Permutations(Devs) \cup Permutations(Conns) \cup Permutations(IPs)

------------------------------------------------------------------------------
(* ---------------- properties -------------------------------------------- *)

TypeOK ==
    /\ phase \in {"down", "starting", "up"}
    /\ mem \subseteq Devs /\ persisted \subseteq Devs /\ minted \subseteq Devs
    /\ \A f \in IPs : fails[f] <= FailIp
    /\ gfails <= FailGlobal

(* A socket is authorised only for a device that exists in the store and was  *)
(* minted by a successful redemption of an issued, unexpired, unused code.    *)
AuthedOnlyPaired ==
    \A k \in Conns : conn[k] = "authed" => (cdev[k] \in mem /\ via[cdev[k]] /= None)

(* Every device came from exactly one redemption; a non-fixed code never      *)
(* yields two devices.  PHONECODE_PAIR_CODE (Fixed) is the explicit exception.*)
SingleUse == \A c \in Codes : Cardinality({e \in minted : via[e] = c}) <= 1
OnlyFixedReusable == \A e \in minted : via[e] /= None

(* Rate limit: within one window at most FailIp failures per IP and         *)
(* FailGlobal overall reach the code comparison.                            *)
RateLimitHolds == (\A f \in IPs : fails[f] <= FailIp) /\ gfails <= FailGlobal

(* Revocation: once the CLI said "Revoked", the device is not in the store   *)
(* (not even after a restart) and none of its sockets is authorised.        *)
RevokedStaysRevoked ==
    \A d \in revoked : (Served => d \notin mem) /\ (\A k \in Conns : conn[k] = "authed" => cdev[k] /= d)

(* ... and it cannot come back as a new device through a handoff code it    *)
(* minted before the revocation.                                            *)
NoHandoffAfterRevoke == \A e \in minted : ~orphan[e]

(* ... and no device paired through it (its handoff codes, transitively)  *)
(* stays authorised: none is in the store or has an authorised socket.     *)
RevokeCascades ==
    \A e \in minted : Ancestors(e) \cap revoked /= {} =>
        /\ (Served => e \notin mem)
        /\ \A k \in Conns : conn[k] = "authed" => cdev[k] /= e

(* ... and no message of it is acted on after the revocation. *)
NoActAfterRevoke == ~actedAfterRevoke

(* Stronger: no effect of any request of it takes place after the revocation *)
(* (requests already being handled when the revocation arrives included).   *)
NoEffectAfterRevoke == ~effectAfterRevoke

(* Hello deadline: an unauthenticated socket is eventually closed or authed. *)
HelloDeadline == \A k \in Conns : (conn[k] = "pre") ~> (conn[k] /= "pre")

=============================================================================
