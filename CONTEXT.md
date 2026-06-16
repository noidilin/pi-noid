# Pi Extensions Context

This context names the project-specific concepts used by the local pi extensions. It keeps Ralph orchestration language stable across implementation, notes, and architecture reviews.

## Language

**Ralph orchestration**:
A controller Ralph workflow that runs the open child issues under one GitHub parent issue in dependency order inside herdr.
_Avoid_: meta runner, parent service, orchestration component

**Parent orchestration**:
The pi session running `/ralph orchestrate ...`; it owns planning order, pause policy, stop handling, and parent issue finalization.
_Avoid_: controller service, parent agent, coordinator component

**Child Ralph session**:
A fresh pi process running `/ralph implement #<child> ...` for exactly one child issue.
_Avoid_: worker agent, child service, implementation component

**Child run**:
One parent-orchestration attempt to execute and verify a single child Ralph session, including session identity, herdr launch, child completion evidence, GitHub closure, commit range, progress facts, and diagnostics.
_Avoid_: worker step, issue job, child task

**Herdr worker adapter**:
The Ralph module that hides herdr CLI calls, worker-pane shell launch, sentinel matching, exit-code parsing, and pane-tail diagnostics behind one interface.
_Avoid_: pane helper collection, shell wrapper, output parser

**Orchestration projection**:
The pure Ralph module that maps Ralph orchestration state, child Ralph session summaries, note paths, and caller-provided time into user-facing text such as plan output, status lines, notes, failure diagnostics, and parent summaries. It does not read files, mutate state, or call time itself.
_Avoid_: status helper, view service, formatter collection

**Orchestration state contract**:
The strict, versioned crash-resume contract stored in parent orchestration state and child Ralph session state. It records the latest durable facts needed to recover parent orchestration after pane, process, or agent interruption.
_Avoid_: cache, best-effort metadata, loose state shape

**Orchestration child link**:
The explicit bidirectional link between one parent orchestration issue run and one child Ralph session. It identifies the orchestration name, parent issue, child issue, issue run index, and parent state path so resume does not depend on naming conventions alone.
_Avoid_: session-name convention, implicit worker link, inferred relationship
