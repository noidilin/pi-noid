# noid-ralph scoped refactor plan

Status: in progress
Scope: `packages/noid-ralph/`
Reference implementation: `ref/ralph-tui/`

Progress:

- Slice 0 complete: current target lifecycle, prompt phases, events, widget output, and schema-v2 parsing are characterized.
- Slice 1 complete: target resolution and source-specific finalization live behind the normalized `tracker-adapter.ts` facade; implementation state remains schema v2 through an explicit compatibility mapping.
- Slice 2 complete: deterministic acceptance-criteria extraction is wired into target resolution; implementation state schema v3 durably stores the normalized target plan, with explicit v2 migration marking criteria unresolved; all five implementation prompt phases render through typed named templates.
- Slice 3 foundation complete: `ralph-state-storage.ts` owns safe iteration paths and atomic JSON replacement; `iteration-log.ts` opens durable `running` records before kickoff and next-target prompts.

Next agent: continue Slice 3 one failing temporary-filesystem test at a time. Add validated iteration reads and lifecycle transitions without overwriting stale `running` attempts, then persist implementation acceptance attempts and child-run progress before implementing archive/cancel/clean policy.

## 1. Goal

Refactor `noid-ralph` so that target handling, prompt construction, acceptance checks, iteration evidence, status reporting, and preflight diagnostics each have a clear seam. Borrow the useful execution-discipline ideas from `ralph-tui` without turning the Pi extension into a standalone Ralph runtime or TUI.

The finished extension should still feel like the current workflow:

1. The user starts `/ralph implement ...` or `/ralph orchestrate ...` inside Pi.
2. Ralph selects exactly one implementation target.
3. The agent implements and validates that target, creates a local commit, and updates Ralph notes.
4. `matt_ralph_done` accepts explicit completion evidence and advances only when the target's acceptance contract is satisfied.
5. Pi's widget and status line project durable Ralph facts; herdr remains the sequential child-session runner.
6. Ralph records enough evidence to diagnose or resume interrupted work without relying on the chat transcript.

This is a refactor and incremental capability expansion, not a rewrite.

## 2. Guardrails

The implementation must preserve these constraints:

- Keep one implementation target per loop.
- Keep Ralph inside Pi and herdr; do not create a standalone CLI or TUI.
- Keep Matt-style skills central: `tdd`, `diagnose`, and `grill-with-docs` where applicable.
- Create local commits only. Never add automatic push behavior.
- Do not introduce a general tracker plugin ecosystem.
- Do not add worktree parallelism; herdr child sessions remain sequential.
- Do not add a remote-control or dashboard server.
- Do not rewrite sandbox, runtime, or environment isolation.
- Do not add AI merge or conflict resolution.
- Keep `.ralph/` out of normal commits and preserve the existing commit guard.
- Treat Pi UI as a projection of Ralph state, not as the source of truth.

## 3. Design principles

### 3.1 Deep lifecycle modules, thin command shells

`index.ts`, `implementation-session.ts`, and `orchestrate.ts` should remain command and lifecycle shells. They parse Pi inputs, invoke deeper modules, execute returned effects, and connect results to Pi APIs. Target interpretation, prompt rendering, acceptance policy, log persistence, and diagnostic checks should live behind smaller interfaces.

The deletion test should hold for every new module: deleting it should spread meaningful policy back across several lifecycle call sites, rather than merely remove a pass-through file.

### 3.2 Durable facts before projections

State and iteration records are durable contracts. Events, status text, widgets, notices, and notes are projections of those facts. A UI update must not be the only record that a target started, failed acceptance, advanced, or completed.

### 3.3 Explicit evidence, independently checked invariants

The agent supplies validation and acceptance evidence. Ralph independently checks facts it can establish locally, including the active target, local commit movement, state ordering, and notes/log persistence. Free-form claims must not replace independently checkable invariants.

### 3.4 Internal adapters, small external interfaces

GitHub issues, local PRDs, and free-text targets genuinely vary, so an internal adapter seam is justified. The lifecycle shell should not operate a public plugin registry. It should call a small target-source module that selects the appropriate internal adapter and returns one normalized target plan.

### 3.5 Backward-compatible rollout

Each slice must be independently testable and shippable. Existing v2 implementation state must either continue to load or be migrated explicitly; it must not disappear silently from status and resume commands.

## 4. Proposed module map

```text
packages/noid-ralph/
  acceptance.ts             # criteria extraction and completion gate
  doctor.ts                 # reusable diagnostic checks and report projection
  iteration-log.ts          # durable per-attempt evidence records
  prompt-template.ts        # named built-in templates and typed contexts
  ralph-events.ts           # typed Ralph event union and event snapshots
  tracker-adapter.ts        # target-source facade plus internal adapters

  index.ts                  # Pi registration, command parsing, effect execution
  implementation-session.ts # implementation lifecycle shell
  orchestrate.ts            # parent orchestration lifecycle shell
  child-run.ts              # child-run execution and verification
  ralph-state-storage.ts    # shared .ralph layout and atomic persistence primitives
```

The filenames are seams, not a requirement to create shallow wrappers. If an implementation slice shows that two proposed files have inseparable policy and a smaller combined interface, combine them and record the reason in the commit.

## 5. Shared domain contracts

The exact field names may be refined test-first, but implementation should converge on these concepts.

### 5.1 Resolved implementation target

A raw command argument becomes a normalized target before session state is created.

```ts
type TargetSourceKind = "github" | "prd" | "text";

type AcceptanceCriterion = {
  id: string;            // stable within the resolved target
  text: string;
  source: "section" | "checklist" | "structured";
};

type ResolvedImplementationTarget = {
  key: string;           // stable source-specific identity
  source: TargetSourceKind;
  title: string;
  body?: string;
  issueNumber?: number;
  parentIssueNumber?: number;
  state?: "open" | "closed";
  acceptanceCriteria: AcceptanceCriterion[];
};

type ResolvedTargetPlan = {
  root: ResolvedImplementationTarget;
  targets: ResolvedImplementationTarget[];
};
```

`ChildIssue` can be evolved or replaced by this normalized target shape. Orchestration-specific dependency planning remains in `orchestrate-planner.ts`; the target-source seam does not absorb orchestration ordering.

### 5.2 Acceptance contract and completion evidence

An acceptance contract is the normalized set of requirements for the current target plus Ralph's invariant workflow requirements.

```ts
type CriterionEvidence = {
  criterionId: string;
  evidence: string;
};

type ValidationEvidence = {
  command: string;
  outcome: string;
};

type TargetCompletionEvidence = {
  summary: string;
  criteria: CriterionEvidence[];
  validation: ValidationEvidence[];
  commit: string;
  notesUpdated: boolean;
};

type AcceptanceDecision =
  | { accepted: true; evidence: TargetCompletionEvidence }
  | { accepted: false; reasons: string[] };
```

The final `matt_ralph_done` schema should require structured evidence. The gate checks, at minimum:

- the state still points at the target for which evidence was supplied;
- every extracted criterion has non-empty evidence, when criteria exist;
- at least one validation result is recorded;
- `commit` resolves locally and is after the target's recorded starting HEAD;
- the Ralph notes file exists and the completion evidence is durably recorded;
- no advancement occurs when any check fails.

A target with no extractable criteria is not blocked forever. It still requires summary, validation, commit, and notes evidence; the iteration log records that no source criteria were present.

### 5.3 Iteration evidence record

State answers “what should resume do now?” Iteration records answer “what happened during this attempt?” They are separate contracts.

```ts
type IterationOutcome = "running" | "accepted" | "rejected" | "failed" | "interrupted";

type RalphIterationRecord = {
  schemaVersion: 1;
  sessionName: string;
  iteration: number;
  targetKey: string;
  targetTitle: string;
  source: TargetSourceKind;
  startedAt: string;
  endedAt?: string;
  outcome: IterationOutcome;
  headBefore?: string;
  headAfter?: string;
  commits?: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  completionEvidence?: TargetCompletionEvidence;
  rejectionReasons?: string[];
  validation?: ValidationEvidence[];
  childRun?: {
    workerScript?: string;
    workerLaunchedAt?: string;
    workerExitedAt?: string;
    workerExitCode?: number;
    paneTail?: string;
  };
  failureReason?: string;
};
```

Canonical location:

```text
.ralph/iterations/<session-name>/<zero-padded-iteration>-<target-key>.json
```

The record is structured JSON. Existing session notes remain the concise human narrative and link to iteration records. Do not persist the full Pi transcript. Pane tails and command output included in records must be bounded to avoid unbounded files and accidental secret capture.

### 5.4 Typed Ralph events

Use one discriminated union rather than string names paired with untyped payload records.

```ts
type RalphEvent =
  | { type: "session.started"; at: string; sessionName: string; targetCount: number }
  | { type: "target.started"; at: string; sessionName: string; iteration: number; targetKey: string }
  | { type: "target.acceptanceRejected"; at: string; sessionName: string; reasons: string[] }
  | { type: "target.completed"; at: string; sessionName: string; iteration: number; targetKey: string }
  | { type: "childRun.progress"; at: string; orchestrationName: string; issue: number; phase: string }
  | { type: "session.paused"; at: string; sessionName: string; reason?: string }
  | { type: "session.completed"; at: string; sessionName: string };
```

The final union should cover implementation-session and child-run lifecycle facts needed by logs and UI, but should not mirror every internal function call. A single emitter maps these events to stable `pi.events` names such as `matt_ralph:target.completed` and passes them to persistence/projection consumers.

## 6. Feature plan

### 6.1 Tracker adapter seam

#### Meaning for this Pi extension

Create a small target-source module that hides how GitHub issues, local PRDs, and free text become a normalized target plan. Keep adapter selection internal. This is not a runtime plugin registry and does not permit third-party tracker loading.

The module's external interface should be close to:

```ts
resolveTargetPlan(input, dependencies): Promise<ResolvedTargetPlan>
finalizeTargetPlan(plan, completion, dependencies): Promise<FinalizationSummary>
```

Internally, GitHub, PRD, and text adapters may satisfy a common interface. Only GitHub finalization performs comments or closure. PRD and text finalization return an explicit no-op result.

#### Reference implementation

- `ref/ralph-tui/src/plugins/trackers/types.ts`
- `ref/ralph-tui/src/plugins/trackers/registry.ts`
- `ref/ralph-tui/src/plugins/trackers/builtin/json/index.ts`
- `ref/ralph-tui/src/plugins/trackers/builtin/beads-rust/index.ts`

Borrow normalized task concepts and adapter locality. Do not borrow plugin metadata, setup questions, registries, dynamic loading, synchronization, or generic status mutation.

#### Local seams

- `packages/noid-ralph/implementation-session.ts`
  - move `describeTarget`, `resolveTargets`, `githubIssueNumbersFor`, and source-specific finalization policy;
  - reduce `ImplementationSessionAdapters` so lifecycle policy does not expose every GitHub operation directly.
- `packages/noid-ralph/github.ts`
  - remain the concrete GitHub command adapter.
- `packages/noid-ralph/types.ts`
  - replace or evolve `TargetDescriptor` and `ChildIssue` toward normalized resolved targets.
- `packages/noid-ralph/orchestrate.ts`
  - use normalized GitHub target facts where useful, without moving dependency planning out of `orchestrate-planner.ts`.

#### Completion criteria

- GitHub parent, GitHub child, standalone GitHub issue, local Markdown path, and free-text behavior have characterization tests.
- The implementation lifecycle consumes only normalized plans.
- Source-specific closure logic no longer lives in `implementation-session.ts`.
- No public tracker registry or plugin configuration exists.

### 6.2 Named prompt templates

#### Meaning for this Pi extension

Move all prompt bodies out of `prompt.ts` into named built-in templates rendered from typed context. Initial scope is built-in templates only:

- `implementation.kickoff`
- `implementation.resume`
- `implementation.next`
- `implementation.finalVerification`
- `implementation.systemInjection`

Use a small renderer such as `renderRalphPrompt(name, context)`. Prefer typed TypeScript template functions or a minimal deterministic interpolator; do not add Handlebars solely to copy `ralph-tui`. User-supplied template lookup and a global template directory are deferred until a real customization requirement exists.

Template contexts should include normalized target facts, acceptance criteria, notes path, iteration limits, initial dirty status, parent context, and workflow policy. Formatting helpers remain private to the prompt-template module.

#### Reference implementation

- `ref/ralph-tui/src/templates/engine.ts`
- `ref/ralph-tui/src/templates/types.ts`
- `ref/ralph-tui/src/templates/builtin.ts`
- `ref/ralph-tui/src/plugins/trackers/builtin/beads/template.hbs`
- `ref/ralph-tui/src/plugins/trackers/builtin/json/template.hbs`
- `ref/ralph-tui/src/plugins/trackers/builtin/beads-rust/template.hbs`

Borrow named templates, one typed context, and explicit acceptance sections. Defer template resolution hierarchies, global installation, and tracker-owned template files.

#### Local seams

- Replace `packages/noid-ralph/prompt.ts` with `prompt-template.ts`, or keep `prompt.ts` only as a temporary compatibility re-export during one slice.
- `packages/noid-ralph/implementation-session.ts` builds typed contexts instead of assembling prose.
- `packages/noid-ralph/index.ts` continues injecting the rendered system prompt through `before_agent_start`.

#### Completion criteria

- No lifecycle shell contains a multiline agent prompt.
- Every named template has snapshot or exact-string tests.
- Acceptance criteria are rendered once, without duplicating their source section in the general description.
- Prompt behavior for old v2 sessions remains defined during migration.

### 6.3 Acceptance-driven backpressure

#### Meaning for this Pi extension

Extract acceptance criteria while resolving the target, display them in every applicable work prompt, and prevent `matt_ralph_done` from advancing without structured evidence.

Criteria extraction order:

1. explicitly structured source fields, if the source supplies them;
2. a Markdown `Acceptance Criteria` section, accepting reasonable heading levels;
3. task-list items in the relevant issue/PRD section;
4. no source criteria, with Ralph's invariant workflow requirements still active.

Extraction must be deterministic and tested against malformed headings, checked and unchecked boxes, multiple sections, and criteria-free text. Checked source boxes are still requirements unless source semantics clearly mark them as already satisfied.

`matt_ralph_done` becomes the enforcement point. A rejected call returns actionable reasons, persists a rejected iteration decision, emits a typed rejection event, and leaves `currentIndex` and `iteration` unchanged. A successful call durably records evidence before changing state and queueing the next prompt.

Final verification must ensure all targets have accepted iteration records before honoring `MATT_RALPH_COMPLETE`. Message-marker detection remains a final-session signal, not a bypass around per-target acceptance.

#### Reference implementation

- `ref/ralph-tui/src/templates/engine.ts` (`extractAcceptanceCriteria`, `getAcceptanceCriteria`)
- `ref/ralph-tui/src/templates/builtin.ts`
- `ref/ralph-tui/src/prd/parser.ts`
- `ref/ralph-tui/src/prd/types.ts`

Borrow criteria extraction and prominent prompt placement. Strengthen the local design by making advancement evidence explicit rather than inferring completion from prose.

#### Local seams

- New `packages/noid-ralph/acceptance.ts` owns extraction and gate decisions.
- `packages/noid-ralph/tracker-adapter.ts` supplies source content and structured criteria.
- `packages/noid-ralph/prompt-template.ts` renders the contract.
- `packages/noid-ralph/index.ts` evolves the `matt_ralph_done` TypeBox schema and forwards typed evidence.
- `packages/noid-ralph/implementation-session.ts` applies accepted/rejected decisions and ordering.
- `packages/noid-ralph/github.ts` remains transport only; it must not decide acceptance.

#### Completion criteria

- Advancement without evidence fails without mutating progress.
- Missing criterion evidence names each uncovered criterion.
- A commit that predates the current target is rejected.
- Rejected and accepted decisions survive restart in iteration records.
- Final completion cannot close GitHub issues if any target lacks an accepted record.

### 6.4 Durable iteration logs

#### Meaning for this Pi extension

Add a structured record for every implementation attempt and child run. Logs supplement, rather than replace, the strict state files and Markdown notes:

- state: latest crash-resume facts;
- iteration record: immutable or append-safe attempt evidence;
- notes: concise human narrative.

Write the initial `running` record before sending the work prompt. Rewrite it atomically as evidence arrives and close it as accepted, rejected, failed, or interrupted. Resume detects a stale `running` record and closes or continues it according to explicit recovery rules; it must not quietly overwrite the attempt.

For herdr children, persist session identity, launch/exit timestamps, exit code, child state facts, commit range, failure reason, and a bounded pane tail. Reuse facts already produced by `ChildRunProgress` instead of scraping UI text.

#### Reference implementation

- `ref/ralph-tui/src/session/persistence.ts`
- `ref/ralph-tui/src/logs/persistence.ts`
- `ref/ralph-tui/src/logs/progress.ts`
- `ref/ralph-tui/src/engine/index.ts` (`saveIterationLog` call sites)

Borrow separation of session state and iteration history, structured metadata, stable filenames, and diagnostic persistence. Do not copy raw-agent-output capture because Pi owns the conversation runtime.

#### Local seams

- New `packages/noid-ralph/iteration-log.ts` owns record validation, paths, and lifecycle transitions.
- `packages/noid-ralph/ralph-state-storage.ts` adds iteration-directory helpers and atomic JSON writes.
- `packages/noid-ralph/loop-store.ts` remains implementation-state persistence.
- `packages/noid-ralph/orchestrate-store.ts` remains parent-state persistence.
- `packages/noid-ralph/implementation-session.ts` opens and closes implementation records.
- `packages/noid-ralph/child-run.ts` emits facts; it does not format files.
- `packages/noid-ralph/orchestrate.ts` connects child progress to iteration persistence.

#### Completion criteria

- Every started target has a durable record before its prompt is sent.
- Accepted and rejected evidence can be read after a fresh process starts.
- Child failure records contain bounded diagnostics and commit facts when available.
- Iteration paths cannot escape `.ralph/iterations` through target/session names.
- Partial writes cannot leave valid-looking truncated JSON; use temp-file-plus-rename atomic writes.
- Existing archive and clean behavior has an explicit policy for iteration directories.

Archive policy: move a session's iteration directory under `.ralph/archive/iterations/<session-name>/`. `cancel` leaves logs intact with notes. `clean --all` removes logs for the completed sessions it removes; plain `clean` removes state only and preserves diagnostics.

### 6.5 Typed events and richer status projections

#### Meaning for this Pi extension

Represent implementation and child-run lifecycle transitions as typed Ralph events. Use them to update durable records and produce richer Pi status/widget projections without importing TUI concerns into lifecycle modules.

The compact default widget should show:

- implementation or orchestration mode;
- active target and target count;
- iteration and current phase;
- acceptance coverage or the latest rejection count;
- validation/commit evidence status;
- warning/failure summary;
- notes and current iteration-record path.

Keep the widget compact and width-safe. Detailed history belongs in `/ralph status` and iteration files, not in a standalone dashboard. Continue using Pi's `ctx.ui.setStatus` and `ctx.ui.setWidget`; do not build a custom full-screen TUI.

#### Reference implementation

- `ref/ralph-tui/src/engine/types.ts`
- `ref/ralph-tui/src/tui/components/ProgressDashboard.tsx`
- `ref/ralph-tui/src/tui/components/RunApp.tsx`
- `ref/ralph-tui/src/tui/components/SubagentTreePanel.tsx`

Borrow typed event vocabulary and clear progress facts. Do not borrow React/Ink components or dashboard navigation.

Pi references:

- Pi extension docs: `docs/extensions.md`, especially `pi.events`, `setStatus`, and `setWidget`.
- Pi TUI docs: `docs/tui.md`, especially width limits, theme callbacks, and invalidation.
- Pi examples: `examples/extensions/event-bus.ts`, `status-line.ts`, and `plan-mode/index.ts`.

#### Local seams

- New `packages/noid-ralph/ralph-events.ts` owns the event union and stable Pi event mapping.
- `packages/noid-ralph/index.ts` replaces `emitMattEvent`, enriches `updateMattRalphUI`, and keeps Pi-specific rendering.
- `packages/noid-ralph/implementation-session.ts` returns typed event effects.
- `packages/noid-ralph/child-run.ts` maps or evolves `ChildRunProgress` into Ralph event facts.
- `packages/noid-ralph/orchestrate-projection.ts` remains the pure text projection for orchestration plan/status/notes.

#### Completion criteria

- Event creation is type-checked; arbitrary name/payload pairs are removed from Ralph lifecycle code.
- Existing external event names either remain compatible or have a documented one-release alias.
- UI tests cover narrow widths, final verification, acceptance rejection, pause/failure, and clean teardown.
- Events are not treated as durable storage.

### 6.6 `/ralph doctor`

#### Meaning for this Pi extension

Add a read-mostly preflight command that reports reusable checks for implementation and orchestration. It should help a user fix the environment before creating state, rather than duplicating partial checks across start commands.

Proposed usage:

```text
/ralph doctor
/ralph doctor implement [target]
/ralph doctor orchestrate [#parent]
```

Each check returns a stable id, `pass | warn | fail`, a summary, optional details, and an actionable remediation. The aggregate report is healthy when no required check fails. The command reports through Pi UI and never calls `process.exit`.

Checks:

- current directory is a Git worktree;
- `git` is available;
- `gh` is available and authenticated when a GitHub target/mode needs it;
- herdr context and CLI are available for orchestration mode;
- worktree policy is satisfied for the requested mode;
- required Matt skills are discoverable;
- project guidance exists, warning rather than failing when absent;
- `.ralph` location is writable and its ignore/exclude policy is effective;
- implementation and orchestration state records parse, with unsupported records listed;
- active markers point to existing compatible state;
- named prompt templates render with a synthetic context;
- target resolution succeeds when a target is supplied.

Start commands should call the same check functions with a policy that selects required checks. `/ralph doctor` is the complete report projection; lifecycle preflight returns concise blockers/warnings.

#### Reference implementation

- `ref/ralph-tui/src/commands/doctor.ts`
- `ref/ralph-tui/src/commands/setup.ts`
- `ref/ralph-tui/src/config/schema.ts`
- `ref/ralph-tui/src/plugins/agents/types.ts`

Borrow structured detection/preflight results and actionable reporting. Do not test an external agent by sending a model prompt: Pi is already the running agent host.

#### Local seams

- New `packages/noid-ralph/doctor.ts` owns checks, policy, and pure report formatting.
- `packages/noid-ralph/implementation-session.ts` replaces `preflightWarnings` with shared doctor checks.
- `packages/noid-ralph/orchestrate.ts` replaces `preflight` with the orchestration doctor policy.
- `packages/noid-ralph/github.ts` supplies command/auth/worktree probes.
- `packages/noid-ralph/index.ts` registers routing and completions for `doctor`.

#### Completion criteria

- Doctor output distinguishes failures from advisory warnings.
- Implement and orchestrate starts share checks rather than duplicate them.
- Doctor performs no issue closure, commit, push, or state lifecycle transition.
- Tests run entirely with injected adapters and do not require GitHub or herdr.

## 7. State and compatibility strategy

### 7.1 Schema evolution

Acceptance contracts and current-target baselines are crash-resume facts. When they enter `MattRalphState`, bump `MATT_RALPH_SCHEMA_VERSION` from 2 to 3.

Add an explicit v2-to-v3 migration in `loop-store.ts`:

- preserve session identity, target order, iteration, dirty-state facts, and orchestration links;
- map old `ChildIssue` values to normalized target stubs;
- mark acceptance as unresolved for migrated active targets;
- resolve or request refresh before advancement, never fabricate criteria;
- persist v3 on the next successful lifecycle write;
- keep truly unknown versions as `UnsupportedStateRecord`.

If `OrchestrateState` does not need new resume facts, do not bump its schema merely for typed events or logs. If child iteration-record links become required for resume, bump it separately and provide the same explicit migration discipline.

### 7.2 Ordering guarantees

For successful advancement, preserve this order:

1. evaluate acceptance;
2. persist the completed iteration record;
3. append/update concise notes;
4. persist advanced implementation state;
5. emit external events and update Pi UI;
6. queue the next/final prompt.

For rejection:

1. persist rejection reasons/evidence in the iteration record;
2. append a concise note if useful;
3. emit rejection event and update UI;
4. return reasons without changing target index or iteration.

This ordering ensures a crash cannot visibly advance without durable evidence.

### 7.3 Time and filesystem dependencies

New modules accept `now`, Git, target-source, and storage dependencies rather than constructing them inside policy functions. Tests use in-memory fakes or temporary directories. Production adapters use `pi.exec` and Node filesystem operations.

## 8. Implementation sequence

All slices use TDD: add a failing behavior test, implement through the module interface, refactor, run focused tests, then run the full repository checks. Keep each slice locally committable.

### Slice 0: Characterize current behavior

- Add missing tests around GitHub parent/child/standalone resolution, path/text resolution, finalization selection, prompt phases, event effects, and v2 state parsing.
- Record current Pi event names and widget behavior so compatibility decisions are explicit.
- No production behavior change.

### Slice 1: Introduce target-source adapters

- Add `tracker-adapter.ts` and normalized target types.
- Move target description, resolution, and finalization behind its facade.
- Keep existing prompts and advancement behavior through a temporary mapping if needed.
- Delete replaced private helpers and tests that inspect past the new seam.

### Slice 2: Extract criteria and render named templates (complete)

- Added pure acceptance-criteria extraction tests and implementation.
- Added `prompt-template.ts` with typed contexts and named built-ins.
- Rendered criteria in kickoff/resume/next/system/final prompts as applicable.
- Bumped implementation state to schema v3 so normalized targets and criteria survive restart; v2 migration marks acceptance criteria unresolved until a later source refresh.
- Preserved advancement behavior for criteria-free and migrated targets; enforcement remains deferred to Slice 4.

### Slice 3: Persist iteration records

- Add atomic JSON primitives and safe path tests.
- Open a record before kickoff/next prompts.
- Persist implementation acceptance attempts and child-run progress.
- Add archive/cancel/clean policies and stale-running-record recovery tests.

### Slice 4: Enforce acceptance backpressure

- Evolve `matt_ralph_done` to structured evidence.
- Record per-target starting HEAD and verify local commit movement.
- Reject incomplete evidence without state advancement.
- Require accepted records before final completion/finalization.
- Update tool description, prompt guidelines, and templates together so the model sees the exact contract it must satisfy.

### Slice 5: Type events and enrich Pi projections

- Add `ralph-events.ts` and migrate lifecycle effects.
- Keep compatibility aliases for currently emitted Pi event names if consumers may exist.
- Project acceptance/log/child-run facts into status, widget, and `/ralph status`.
- Keep render functions pure and width-safe.

### Slice 6: Consolidate preflight and ship doctor

- Add `doctor.ts` checks and policies.
- Replace implementation and orchestration preflight duplication.
- Register command routing, help text, and completions.
- Add report tests and Pi command-shell tests.

### Slice 7: Remove migration scaffolding and update docs

- Remove temporary prompt re-exports or compatibility helpers that no longer have callers.
- Update root `README.md` with doctor, evidence requirements, iteration locations, and event/status behavior.
- Review `CONTEXT.md`; add only stable domain terms, not implementation details.
- Run the full validation matrix.

## 9. Test strategy

### Pure module tests

- `tracker-adapter.test.ts`: source selection, normalization, parent/child behavior, no-op finalization, GitHub finalization selection.
- `acceptance.test.ts`: headings, checklists, structured criteria, duplicate handling, stable ids, missing evidence, stale commit, accepted/rejected decisions.
- `prompt-template.test.ts`: every named template and context edge case.
- `ralph-events.test.ts`: event construction and stable external-name mapping.
- `doctor.test.ts`: pass/warn/fail aggregation, mode policies, report formatting.

### Temporary-filesystem tests

- `iteration-log.test.ts`: safe paths, atomic writes, transitions, list/read, stale records, bounded diagnostics, archive/clean behavior.
- `loop-store.test.ts`: v2 migration and v3 round trips.
- `ralph-state-storage.test.ts`: iteration layout and atomic write failure behavior.

### Lifecycle tests

Extend `implementation-session.test.ts` to prove:

- records open before prompt effects;
- rejected evidence does not advance;
- accepted evidence persists before advancement;
- max-iteration behavior still pauses;
- finalization requires all accepted targets;
- resume restores current acceptance/log facts.

Extend `child-run.test.ts` and orchestration tests to prove child facts reach durable logs without making `child-run.ts` responsible for filesystem formatting.

Extend `index.test.ts` to prove TypeBox tool arguments, command routing/completion, event execution, marker handling, and UI teardown.

### Validation commands

Run focused Vitest files during each red-green-refactor cycle, then:

```text
pnpm test
pnpm run check
```

Because `check` runs Biome with `--write`, inspect `git diff` afterward and stage only intended files.

Manual smoke test after the relevant slices:

1. `/reload` Pi.
2. `/ralph doctor` in a Git repo.
3. Start a text or local-PRD implementation target.
4. Confirm criteria appear in the widget/prompt.
5. Call `matt_ralph_done` with incomplete evidence and confirm no advancement.
6. Complete, validate, commit locally, update notes, and call with full evidence.
7. Restart/resume Pi and inspect `.ralph/iterations/...`.
8. In herdr, run one orchestration child and verify child diagnostics/status projection.

## 10. Risks and mitigations

### State incompatibility

Risk: a schema bump hides existing sessions.
Mitigation: implement and test v2 migration before writing v3 state; retain unsupported-record reporting for unknown versions.

### Agent/tool contract drift

Risk: prompts instruct one completion shape while the TypeBox schema expects another.
Mitigation: define evidence types once, derive or co-locate schema guidance, and test prompt wording alongside tool argument tests.

### False acceptance confidence

Risk: the agent invents passing validation evidence.
Mitigation: independently verify commit and ordering facts; clearly label command outcomes as supplied evidence; never claim Ralph reran commands unless it did. A later explicit “Ralph executes validators” feature is out of this refactor's scope.

### Excessive adapter abstraction

Risk: copying `ralph-tui` creates a plugin framework with only one useful implementation.
Mitigation: keep adapters internal, support only the three existing source kinds, and expose a two-operation facade to lifecycle callers.

### Log growth or secret capture

Risk: raw pane/output data grows without bound or stores credentials.
Mitigation: persist structured facts, cap pane tails, avoid full transcripts/environment dumps, and document clean/archive behavior.

### Event/state races

Risk: UI or external consumers observe completion before evidence is durable.
Mitigation: enforce persistence-before-event ordering and test effect order.

### UI scope creep

Risk: richer status becomes a standalone dashboard.
Mitigation: retain Pi `setStatus`/`setWidget`, compact defaults, and detailed file/status commands; no overlay or full-screen Ralph UI in this plan.

## 11. Explicit non-goals

This plan does not include:

- dynamic tracker discovery or third-party tracker plugins;
- Jira, Linear, Beads, or remote tracker support;
- user/global custom prompt-template installation;
- a standalone `ralph` executable;
- a replacement Pi TUI;
- concurrent child sessions or worktrees;
- automatic pushing;
- AI-assisted merge resolution;
- remote control, webhooks, or dashboard servers;
- sandbox/runtime/environment redesign;
- capture of complete Pi conversation or model token telemetry;
- Ralph executing arbitrary validation commands on behalf of completion evidence.

## 12. Definition of done

The refactor is complete when:

- the six scoped features are implemented through the seams described above;
- one-target-per-loop and local-commit-only policy remain enforced;
- existing v2 implementation sessions have a tested migration path;
- every target attempt has a durable structured iteration record;
- `matt_ralph_done` cannot advance without accepted structured evidence;
- final GitHub closure cannot bypass per-target acceptance;
- Pi status/widget output derives from typed durable facts and remains compact;
- `/ralph doctor` and start commands share diagnostic checks;
- no prohibited standalone/plugin/parallel/remote behavior has been introduced;
- `pnpm test` and `pnpm run check` pass;
- root documentation reflects the shipped command and storage contracts.
