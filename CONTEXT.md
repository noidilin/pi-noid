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
