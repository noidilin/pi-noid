import type { ChildIssue, MattRalphState } from "./types";

export function currentTarget(state: MattRalphState): ChildIssue | undefined {
	return state.childIssues[state.currentIndex];
}

export function buildKickoffPrompt(state: MattRalphState): string {
	return buildIterationPrompt(state, "start");
}

export function buildResumePrompt(state: MattRalphState): string {
	return buildIterationPrompt(state, "resume");
}

export function buildNextPrompt(state: MattRalphState): string {
	return buildIterationPrompt(state, "next");
}

export function buildFinalPrompt(state: MattRalphState): string {
	return `Matt Ralph implementation loop: final verification for session ${state.name}.

All planned implementation targets have been processed.

Do this now:
- Review ${state.taskFile} and the git history from this session.
- Run the appropriate project checks/tests if they have not just passed.
- Ensure each target has a local commit. Never push.
- Update ${state.taskFile} with final results and any follow-up notes.
- Ask before closing/commenting on GitHub issues; do not silently mutate the tracker.
- If everything is complete, respond with exactly this marker in your final assistant message: MATT_RALPH_COMPLETE
- If more work remains, explain what remains and continue without emitting the marker.`;
}

export function buildSystemInjection(state: MattRalphState): string {
	const target = currentTarget(state);
	return `\n\nMatt Ralph active session: ${state.name}
- Mode: ${state.mode}
- Session notes: ${state.taskFile}
- Status: ${state.status}
- Iteration: ${formatIteration(state)}
- Current target: ${formatTarget(target)}
- Scope: implement only the current target unless explicitly asked otherwise.
- When this target is implemented, tested, committed locally, and ${state.taskFile} is updated, call matt_ralph_done unless all targets are done; final completion marker is MATT_RALPH_COMPLETE.
- Ask before closing or commenting on tracker issues. Never push.`;
}

function buildIterationPrompt(state: MattRalphState, phase: "start" | "resume" | "next"): string {
	const target = currentTarget(state);
	const phaseLabel = phase === "start" ? "start" : phase === "resume" ? "resume" : "continue";
	return `Matt Ralph implementation loop: ${phaseLabel} session ${state.name}.

Current implementation target (${state.currentIndex + 1}/${state.childIssues.length}): ${formatTarget(target)}
Iteration: ${formatIteration(state)}
Root input: ${state.rootIssue}
Session notes file: ${state.taskFile}

Workflow instructions:
1. Use Matt Pocock skills already installed/discoverable where relevant. Prefer tdd for implementation, diagnose for bugs, and grill-with-docs only if product/domain ambiguity blocks progress.
2. Read project guidance before changing code: AGENTS.md/CLAUDE.md, docs/agents/*, CONTEXT.md, and ADRs as relevant.
3. If the target is a GitHub issue, fetch it with gh issue view <number> --comments. If this is a PRD child, also read parent issue #${state.parentIssue ?? "<none>"}.
4. Implement only the current target in this iteration. Keep changes scoped.
5. Use test-first discipline where appropriate: red → green → refactor, behavior through public interfaces.
6. Run project checks/tests that validate the change.
7. Create at least one local git commit for this target. Never push.
   - Use Conventional Commits for the commit subject, e.g. feat: add ralph command or fix: handle empty status.
   - Standalone issue body footer: Refs #<issue>
   - Child issue body footer: Part of #<parent> and Refs #<child>
8. Update ${state.taskFile} with progress, validation, commit hash, and open questions.
9. Ask before closing/commenting on GitHub issues; do not silently mutate the tracker.
10. When this iteration is complete, call matt_ralph_done. If all targets are complete after final verification, emit MATT_RALPH_COMPLETE instead.

Initial dirty worktree recorded by preflight:
${state.initialDirtyStatus?.trim() || "<clean>"}`;
}

function formatTarget(target: ChildIssue | undefined): string {
	if (!target) return "<none>";
	const label = target.number > 0 ? `#${target.number} ${target.title}` : target.title;
	return `${label} [${target.state ?? "unknown"}, ${target.source}]`;
}

function formatIteration(state: MattRalphState): string {
	return state.maxIterations ? `${state.iteration}/${state.maxIterations}` : `${state.iteration}`;
}
