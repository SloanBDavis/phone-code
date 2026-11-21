---- MODULE ChatSync_TTrace_1795226277 ----
EXTENDS ChatSync_TEConstants, Sequences, TLCExt, ChatSync, Toolbox, Naturals, TLC

_expression ==
    LET ChatSync_TEExpression == INSTANCE ChatSync_TEExpression
    IN ChatSync_TEExpression!expression
----

_trace ==
    LET ChatSync_TETrace == INSTANCE ChatSync_TETrace
    IN ChatSync_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        toggles = (0)
        /\
        subsHas = (FALSE)
        /\
        discs = (0)
        /\
        bp = (0)
        /\
        dlog = (<<>>)
        /\
        loaded = (FALSE)
        /\
        cT = (<<>>)
        /\
        tok = (1)
        /\
        cSeq = (3)
        /\
        hist = ((3 :> <<[id |-> a, c |-> <<1>>]>>))
        /\
        file = (<<[id |-> a, c |-> <<1>>]>>)
        /\
        stale = (FALSE)
        /\
        d2c = (<<>>)
        /\
        inFan = (FALSE)
        /\
        c2d = (<<>>)
        /\
        subPend = (<<>>)
        /\
        gap = (FALSE)
        /\
        cHas = (TRUE)
        /\
        pend = (None)
        /\
        wantSub = (TRUE)
        /\
        cUp = (FALSE)
        /\
        restarts = (2)
        /\
        dT = (<<[id |-> a, c |-> <<1>>]>>)
        /\
        dSeq = (3)
        /\
        pSeq = (0)
        /\
        inbox = (<<>>)
        /\
        base = (3)
    )
----

_init ==
    /\ subsHas = _TETrace[1].subsHas
    /\ dSeq = _TETrace[1].dSeq
    /\ toggles = _TETrace[1].toggles
    /\ d2c = _TETrace[1].d2c
    /\ bp = _TETrace[1].bp
    /\ cT = _TETrace[1].cT
    /\ cSeq = _TETrace[1].cSeq
    /\ discs = _TETrace[1].discs
    /\ dT = _TETrace[1].dT
    /\ pend = _TETrace[1].pend
    /\ tok = _TETrace[1].tok
    /\ cHas = _TETrace[1].cHas
    /\ file = _TETrace[1].file
    /\ subPend = _TETrace[1].subPend
    /\ pSeq = _TETrace[1].pSeq
    /\ hist = _TETrace[1].hist
    /\ wantSub = _TETrace[1].wantSub
    /\ inFan = _TETrace[1].inFan
    /\ dlog = _TETrace[1].dlog
    /\ cUp = _TETrace[1].cUp
    /\ gap = _TETrace[1].gap
    /\ stale = _TETrace[1].stale
    /\ c2d = _TETrace[1].c2d
    /\ base = _TETrace[1].base
    /\ restarts = _TETrace[1].restarts
    /\ loaded = _TETrace[1].loaded
    /\ inbox = _TETrace[1].inbox
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ subsHas  = _TETrace[i].subsHas
        /\ subsHas' = _TETrace[j].subsHas
        /\ dSeq  = _TETrace[i].dSeq
        /\ dSeq' = _TETrace[j].dSeq
        /\ toggles  = _TETrace[i].toggles
        /\ toggles' = _TETrace[j].toggles
        /\ d2c  = _TETrace[i].d2c
        /\ d2c' = _TETrace[j].d2c
        /\ bp  = _TETrace[i].bp
        /\ bp' = _TETrace[j].bp
        /\ cT  = _TETrace[i].cT
        /\ cT' = _TETrace[j].cT
        /\ cSeq  = _TETrace[i].cSeq
        /\ cSeq' = _TETrace[j].cSeq
        /\ discs  = _TETrace[i].discs
        /\ discs' = _TETrace[j].discs
        /\ dT  = _TETrace[i].dT
        /\ dT' = _TETrace[j].dT
        /\ pend  = _TETrace[i].pend
        /\ pend' = _TETrace[j].pend
        /\ tok  = _TETrace[i].tok
        /\ tok' = _TETrace[j].tok
        /\ cHas  = _TETrace[i].cHas
        /\ cHas' = _TETrace[j].cHas
        /\ file  = _TETrace[i].file
        /\ file' = _TETrace[j].file
        /\ subPend  = _TETrace[i].subPend
        /\ subPend' = _TETrace[j].subPend
        /\ pSeq  = _TETrace[i].pSeq
        /\ pSeq' = _TETrace[j].pSeq
        /\ hist  = _TETrace[i].hist
        /\ hist' = _TETrace[j].hist
        /\ wantSub  = _TETrace[i].wantSub
        /\ wantSub' = _TETrace[j].wantSub
        /\ inFan  = _TETrace[i].inFan
        /\ inFan' = _TETrace[j].inFan
        /\ dlog  = _TETrace[i].dlog
        /\ dlog' = _TETrace[j].dlog
        /\ cUp  = _TETrace[i].cUp
        /\ cUp' = _TETrace[j].cUp
        /\ gap  = _TETrace[i].gap
        /\ gap' = _TETrace[j].gap
        /\ stale  = _TETrace[i].stale
        /\ stale' = _TETrace[j].stale
        /\ c2d  = _TETrace[i].c2d
        /\ c2d' = _TETrace[j].c2d
        /\ base  = _TETrace[i].base
        /\ base' = _TETrace[j].base
        /\ restarts  = _TETrace[i].restarts
        /\ restarts' = _TETrace[j].restarts
        /\ loaded  = _TETrace[i].loaded
        /\ loaded' = _TETrace[j].loaded
        /\ inbox  = _TETrace[i].inbox
        /\ inbox' = _TETrace[j].inbox

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("ChatSync_TTrace_1795226277.json", _TETrace)

=============================================================================

 Note that you can extract this module `ChatSync_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `ChatSync_TEExpression.tla` file takes precedence 
  over the module `ChatSync_TEExpression` below).

---- MODULE ChatSync_TEExpression ----
EXTENDS ChatSync_TEConstants, Sequences, TLCExt, ChatSync, Toolbox, Naturals, TLC

expression == 
    [
        \* To hide variables of the `ChatSync` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        subsHas |-> subsHas
        ,dSeq |-> dSeq
        ,toggles |-> toggles
        ,d2c |-> d2c
        ,bp |-> bp
        ,cT |-> cT
        ,cSeq |-> cSeq
        ,discs |-> discs
        ,dT |-> dT
        ,pend |-> pend
        ,tok |-> tok
        ,cHas |-> cHas
        ,file |-> file
        ,subPend |-> subPend
        ,pSeq |-> pSeq
        ,hist |-> hist
        ,wantSub |-> wantSub
        ,inFan |-> inFan
        ,dlog |-> dlog
        ,cUp |-> cUp
        ,gap |-> gap
        ,stale |-> stale
        ,c2d |-> c2d
        ,base |-> base
        ,restarts |-> restarts
        ,loaded |-> loaded
        ,inbox |-> inbox
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_subsHasUnchanged |-> subsHas = subsHas'
        
        \* Format the `subsHas` variable as Json value.
        \* ,_subsHasJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(subsHas)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_subsHasModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].subsHas # _TETrace[s-1].subsHas
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE ChatSync_TETrace ----
\*EXTENDS ChatSync_TEConstants, IOUtils, ChatSync, TLC
\*
\*trace == IODeserialize("ChatSync_TTrace_1795226277.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE ChatSync_TETrace ----
EXTENDS ChatSync_TEConstants, ChatSync, TLC

trace == 
    <<
    ([toggles |-> 0,subsHas |-> FALSE,discs |-> 0,bp |-> 0,dlog |-> <<>>,loaded |-> TRUE,cT |-> <<>>,tok |-> 0,cSeq |-> 0,hist |-> (0 :> <<>>),file |-> <<>>,stale |-> FALSE,d2c |-> <<>>,inFan |-> FALSE,c2d |-> <<>>,subPend |-> <<>>,gap |-> FALSE,cHas |-> FALSE,pend |-> None,wantSub |-> TRUE,cUp |-> FALSE,restarts |-> 0,dT |-> <<>>,dSeq |-> 0,pSeq |-> 0,inbox |-> <<>>,base |-> 0]),
    ([toggles |-> 0,subsHas |-> FALSE,discs |-> 0,bp |-> 0,dlog |-> <<>>,loaded |-> FALSE,cT |-> <<>>,tok |-> 0,cSeq |-> 0,hist |-> (3 :> <<>>),file |-> <<>>,stale |-> FALSE,d2c |-> <<>>,inFan |-> FALSE,c2d |-> <<>>,subPend |-> <<>>,gap |-> FALSE,cHas |-> FALSE,pend |-> None,wantSub |-> TRUE,cUp |-> FALSE,restarts |-> 1,dT |-> <<>>,dSeq |-> 3,pSeq |-> 0,inbox |-> <<>>,base |-> 3]),
    ([toggles |-> 0,subsHas |-> FALSE,discs |-> 0,bp |-> 0,dlog |-> <<>>,loaded |-> FALSE,cT |-> <<>>,tok |-> 0,cSeq |-> 0,hist |-> (3 :> <<>>),file |-> <<>>,stale |-> FALSE,d2c |-> <<>>,inFan |-> FALSE,c2d |-> <<[after |-> 0, t |-> "sub", has |-> FALSE]>>,subPend |-> <<>>,gap |-> FALSE,cHas |-> FALSE,pend |-> None,wantSub |-> TRUE,cUp |-> TRUE,restarts |-> 1,dT |-> <<>>,dSeq |-> 3,pSeq |-> 0,inbox |-> <<>>,base |-> 3]),
    ([toggles |-> 0,subsHas |-> TRUE,discs |-> 0,bp |-> 0,dlog |-> <<>>,loaded |-> FALSE,cT |-> <<>>,tok |-> 0,cSeq |-> 0,hist |-> (3 :> <<>>),file |-> <<>>,stale |-> FALSE,d2c |-> <<>>,inFan |-> FALSE,c2d |-> <<>>,subPend |-> <<[after |-> 0, has |-> FALSE]>>,gap |-> FALSE,cHas |-> FALSE,pend |-> None,wantSub |-> TRUE,cUp |-> TRUE,restarts |-> 1,dT |-> <<>>,dSeq |-> 3,pSeq |-> 0,inbox |-> <<>>,base |-> 3]),
    ([toggles |-> 0,subsHas |-> TRUE,discs |-> 0,bp |-> 0,dlog |-> <<>>,loaded |-> TRUE,cT |-> <<>>,tok |-> 0,cSeq |-> 0,hist |-> (3 :> <<>>),file |-> <<>>,stale |-> FALSE,d2c |-> <<[id |-> None, kind |-> "snap", seq |-> 3, toks |-> <<>>, items |-> <<>>]>>,inFan |-> TRUE,c2d |-> <<>>,subPend |-> <<>>,gap |-> FALSE,cHas |-> FALSE,pend |-> None,wantSub |-> TRUE,cUp |-> TRUE,restarts |-> 1,dT |-> <<>>,dSeq |-> 3,pSeq |-> 0,inbox |-> <<>>,base |-> 3]),
    ([toggles |-> 0,subsHas |-> TRUE,discs |-> 0,bp |-> 0,dlog |-> <<[id |-> a, kind |-> "item", seq |-> 4, toks |-> <<1>>, items |-> <<>>]>>,loaded |-> TRUE,cT |-> <<>>,tok |-> 1,cSeq |-> 0,hist |-> (3 :> <<>> @@ 4 :> <<[id |-> a, c |-> <<1>>]>>),file |-> <<>>,stale |-> FALSE,d2c |-> <<[id |-> None, kind |-> "snap", seq |-> 3, toks |-> <<>>, items |-> <<>>], [id |-> a, kind |-> "item", seq |-> 4, toks |-> <<1>>, items |-> <<>>]>>,inFan |-> TRUE,c2d |-> <<>>,subPend |-> <<>>,gap |-> FALSE,cHas |-> FALSE,pend |-> None,wantSub |-> TRUE,cUp |-> TRUE,restarts |-> 1,dT |-> <<[id |-> a, c |-> <<1>>]>>,dSeq |-> 4,pSeq |-> 0,inbox |-> <<>>,base |-> 3]),
    ([toggles |-> 0,subsHas |-> TRUE,discs |-> 0,bp |-> 0,dlog |-> <<[id |-> a, kind |-> "item", seq |-> 4, toks |-> <<1>>, items |-> <<>>]>>,loaded |-> TRUE,cT |-> <<>>,tok |-> 1,cSeq |-> 0,hist |-> (3 :> <<>> @@ 4 :> <<[id |-> a, c |-> <<1>>]>>),file |-> <<[id |-> a, c |-> <<1>>]>>,stale |-> FALSE,d2c |-> <<[id |-> None, kind |-> "snap", seq |-> 3, toks |-> <<>>, items |-> <<>>], [id |-> a, kind |-> "item", seq |-> 4, toks |-> <<1>>, items |-> <<>>]>>,inFan |-> TRUE,c2d |-> <<>>,subPend |-> <<>>,gap |-> FALSE,cHas |-> FALSE,pend |-> None,wantSub |-> TRUE,cUp |-> TRUE,restarts |-> 1,dT |-> <<[id |-> a, c |-> <<1>>]>>,dSeq |-> 4,pSeq |-> 0,inbox |-> <<>>,base |-> 3]),
    ([toggles |-> 0,subsHas |-> TRUE,discs |-> 0,bp |-> 0,dlog |-> <<[id |-> a, kind |-> "item", seq |-> 4, toks |-> <<1>>, items |-> <<>>]>>,loaded |-> TRUE,cT |-> <<>>,tok |-> 1,cSeq |-> 0,hist |-> (3 :> <<>> @@ 4 :> <<[id |-> a, c |-> <<1>>]>>),file |-> <<[id |-> a, c |-> <<1>>]>>,stale |-> FALSE,d2c |-> <<[id |-> a, kind |-> "item", seq |-> 4, toks |-> <<1>>, items |-> <<>>]>>,inFan |-> TRUE,c2d |-> <<>>,subPend |-> <<>>,gap |-> FALSE,cHas |-> FALSE,pend |-> None,wantSub |-> TRUE,cUp |-> TRUE,restarts |-> 1,dT |-> <<[id |-> a, c |-> <<1>>]>>,dSeq |-> 4,pSeq |-> 0,inbox |-> <<[id |-> None, kind |-> "snap", seq |-> 3, toks |-> <<>>, items |-> <<>>]>>,base |-> 3]),
    ([toggles |-> 0,subsHas |-> FALSE,discs |-> 0,bp |-> 0,dlog |-> <<>>,loaded |-> FALSE,cT |-> <<>>,tok |-> 1,cSeq |-> 0,hist |-> (3 :> <<[id |-> a, c |-> <<1>>]>>),file |-> <<[id |-> a, c |-> <<1>>]>>,stale |-> FALSE,d2c |-> <<>>,inFan |-> FALSE,c2d |-> <<>>,subPend |-> <<>>,gap |-> FALSE,cHas |-> FALSE,pend |-> None,wantSub |-> TRUE,cUp |-> FALSE,restarts |-> 2,dT |-> <<[id |-> a, c |-> <<1>>]>>,dSeq |-> 3,pSeq |-> 0,inbox |-> <<[id |-> None, kind |-> "snap", seq |-> 3, toks |-> <<>>, items |-> <<>>]>>,base |-> 3]),
    ([toggles |-> 0,subsHas |-> FALSE,discs |-> 0,bp |-> 0,dlog |-> <<>>,loaded |-> FALSE,cT |-> <<>>,tok |-> 1,cSeq |-> 3,hist |-> (3 :> <<[id |-> a, c |-> <<1>>]>>),file |-> <<[id |-> a, c |-> <<1>>]>>,stale |-> FALSE,d2c |-> <<>>,inFan |-> FALSE,c2d |-> <<>>,subPend |-> <<>>,gap |-> FALSE,cHas |-> TRUE,pend |-> None,wantSub |-> TRUE,cUp |-> FALSE,restarts |-> 2,dT |-> <<[id |-> a, c |-> <<1>>]>>,dSeq |-> 3,pSeq |-> 0,inbox |-> <<>>,base |-> 3])
    >>
----


=============================================================================

---- MODULE ChatSync_TEConstants ----
EXTENDS ChatSync

CONSTANTS a, b

=============================================================================

---- CONFIG ChatSync_TTrace_1795226277 ----
CONSTANTS
    Items = { a , b }
    None = None
    MaxTok = 2
    LogMax = 2
    Margin = 3
    MaxRestarts = 2
    MaxDisc = 1
    MaxBP = 0
    MaxToggle = 0
    FixPersistOnLoad = FALSE
    None = None
    a = a
    b = b

INVARIANT
    _inv

CHECK_DEADLOCK
    \* CHECK_DEADLOCK off because of PROPERTY or INVARIANT above.
    FALSE

INIT
    _init

NEXT
    _next

CONSTANT
    _TETrace <- _trace

ALIAS
    _expression
=============================================================================
\* Generated on Sat Nov 21 01:57:58 UTC 2026