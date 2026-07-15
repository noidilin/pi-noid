import type { MattRalphState, ResolvedImplementationTarget } from "./types";

export type RalphPromptName =
	| "implementation.kickoff"
	| "implementation.resume"
	| "implementation.next"
	| "implementation.finalVerification"
	| "implementation.systemInjection";

type IterationPhase = "start" | "resume" | "next";

export type IterationPromptContext = {
	kind: "iteration";
	phase: IterationPhase;
	sessionName: string;
	notesPath: string;
	iteration: number;
	maxIterations?: number;
	rootInput: string;
	parentIssue?: number;
	target?: ResolvedImplementationTarget;
	targetIndex: number;
	targetCount: number;
	initialDirtyStatus?: string;
};

export type FinalPromptContext = {
	kind: "final";
	sessionName: string;
	notesPath: string;
	targets?: ResolvedImplementationTarget[];
};

export type SystemInjectionContext = {
	kind: "system";
	sessionName: string;
	notesPath: string;
	status: MattRalphState["status"];
	iteration: number;
	maxIterations?: number;
	target?: ResolvedImplementationTarget;
	targetIndex: number;
	targetCount: number;
};

export type RalphPromptContext = IterationPromptContext | FinalPromptContext | SystemInjectionContext;

export function renderRalphPrompt(name: RalphPromptName, context: RalphPromptContext): string {
	switch (name) {
		case "implementation.kickoff":
			return renderIteration(name, context, "start");
		case "implementation.resume":
			return renderIteration(name, context, "resume");
		case "implementation.next":
			return renderIteration(name, context, "next");
		case "implementation.finalVerification":
			if (context.kind !== "final") throw invalidContext(name);
			return renderFinal(context);
		case "implementation.systemInjection":
			if (context.kind !== "system") throw invalidContext(name);
			return renderSystemInjection(context);
	}
}

export function iterationPromptContext(state: MattRalphState, phase: IterationPhase): IterationPromptContext {
	return {
		kind: "iteration",
		phase,
		sessionName: state.name,
		notesPath: state.taskFile,
		iteration: state.iteration,
		maxIterations: state.maxIterations,
		rootInput: state.rootIssue,
		parentIssue: state.parentIssue,
		target: currentTarget(state),
		targetIndex: state.currentIndex,
		targetCount: state.targetPlan.targets.length,
		initialDirtyStatus: state.initialDirtyStatus,
	};
}

export function finalPromptContext(state: MattRalphState): FinalPromptContext {
	return { kind: "final", sessionName: state.name, notesPath: state.taskFile, targets: state.targetPlan.targets };
}

export function systemInjectionContext(state: MattRalphState): SystemInjectionContext {
	return {
		kind: "system",
		sessionName: state.name,
		notesPath: state.taskFile,
		status: state.status,
		iteration: state.iteration,
		maxIterations: state.maxIterations,
		target: currentTarget(state),
		targetIndex: state.currentIndex,
		targetCount: state.targetPlan.targets.length,
	};
}

export function buildKickoffPrompt(state: MattRalphState): string {
	return renderRalphPrompt("implementation.kickoff", iterationPromptContext(state, "start"));
}

export function buildResumePrompt(state: MattRalphState): string {
	return renderRalphPrompt("implementation.resume", iterationPromptContext(state, "resume"));
}

export function buildNextPrompt(state: MattRalphState): string {
	return renderRalphPrompt("implementation.next", iterationPromptContext(state, "next"));
}

export function buildFinalPrompt(state: MattRalphState): string {
	return renderRalphPrompt("implementation.finalVerification", finalPromptContext(state));
}

export function buildSystemInjection(state: MattRalphState): string {
	return renderRalphPrompt("implementation.systemInjection", systemInjectionContext(state));
}

function currentTarget(state: MattRalphState): ResolvedImplementationTarget | undefined {
	return state.targetPlan.targets[state.currentIndex];
}

function renderIteration(name: RalphPromptName, context: RalphPromptContext, phase: IterationPhase): string {
	if (context.kind !== "iteration" || context.phase !== phase) throw invalidContext(name);
	const phaseLabel = phase === "start" ? "start" : phase === "resume" ? "resume" : "continue";
	return `Matt Ralph implementation loop: ${phaseLabel} session ${context.sessionName}.

Current implementation target (${context.targetIndex + 1}/${context.targetCount}): ${formatTarget(context.target)}
Iteration: ${formatIteration(context.iteration, context.maxIterations)}
Root input: ${context.rootInput}
Session notes file: ${context.notesPath}

${acceptanceSection(context.target)}

Workflow instructions:
1. Use Matt Pocock skills already installed/discoverable where relevant. Prefer tdd for implementation, diagnose for bugs, and grill-with-docs only if product/domain ambiguity blocks progress.
2. Read project guidance before changing code: AGENTS.md/CLAUDE.md, docs/agents/*, CONTEXT.md, and ADRs as relevant.
3. If the target is a GitHub issue, fetch it with gh issue view <number> --comments. If this is a PRD child, also read parent issue #${context.parentIssue ?? "<none>"}.
4. Implement only the current target in this iteration. Keep changes scoped.
5. Use test-first discipline where appropriate: red → green → refactor, behavior through public interfaces.
6. Run project checks/tests that validate the change.
7. Create at least one local git commit for this target. Never push.
   - Use Conventional Commits for the commit subject, e.g. feat: add ralph command or fix: handle empty status.
   - Standalone issue body footer: Refs #<issue>
   - Child issue body footer: Part of #<parent> and Refs #<child>
8. Update ${context.notesPath} with progress, validation, commit hash, and open questions.
9. Ask before closing/commenting on GitHub issues during normal iterations; final completion is automatic after MATT_RALPH_COMPLETE.
10. When this iteration is complete, call matt_ralph_done. If all targets are complete after final verification, emit MATT_RALPH_COMPLETE instead.

Initial dirty worktree recorded by preflight:
${context.initialDirtyStatus?.trim() || "<clean>"}`;
}

function renderFinal(context: FinalPromptContext): string {
	return `Matt Ralph implementation loop: final verification for session ${context.sessionName}.

All planned implementation targets have been processed.

Acceptance contracts reviewed:
${formatFinalAcceptance(context.targets ?? [])}

Do this now:
- Review ${context.notesPath} and the git history from this session.
- Run the appropriate project checks/tests if they have not just passed.
- Ensure each target has a local commit. Never push.
- Update ${context.notesPath} with final results and any follow-up notes.
- Do not close/comment on GitHub issues yourself; after you emit the completion marker, the Ralph extension comments "Final verification" and closes GitHub issue targets automatically.
- If everything is complete, respond with exactly this marker in your final assistant message: MATT_RALPH_COMPLETE
- If more work remains, explain what remains and continue without emitting the marker.`;
}

function renderSystemInjection(context: SystemInjectionContext): string {
	return `\n\nMatt Ralph active session: ${context.sessionName}
- Mode: implement
- Session notes: ${context.notesPath}
- Status: ${context.status}
- Iteration: ${formatIteration(context.iteration, context.maxIterations)}
- Current target: ${formatTarget(context.target)}
${acceptanceSection(context.target)}
- Scope: implement only the current target unless explicitly asked otherwise.
- When this target is implemented, tested, committed locally, and ${context.notesPath} is updated, call matt_ralph_done unless all targets are done; final completion marker is MATT_RALPH_COMPLETE.
- Do not close/comment on tracker issues yourself during final completion; the Ralph extension handles GitHub finalization after MATT_RALPH_COMPLETE. Never push.`;
}

function acceptanceSection(target: ResolvedImplementationTarget | undefined): string {
	if (!target) return "Acceptance contract:\n- <no current target>";
	if (target.acceptanceCriteriaResolved === false) {
		return "Acceptance contract:\n- Acceptance criteria are unresolved for this migrated session. Refresh the source before advancement.";
	}
	if (target.acceptanceCriteria.length === 0) {
		return "Acceptance contract:\n- No source acceptance criteria were found. Workflow validation, a local commit, and updated notes are still required.";
	}
	return `Acceptance contract:\n${target.acceptanceCriteria.map((criterion) => `- [ ] ${criterion.text} (${criterion.id})`).join("\n")}`;
}

function acceptanceSummary(target: ResolvedImplementationTarget | undefined): string {
	if (!target) return "<no current target>";
	if (target.acceptanceCriteriaResolved === false) return "unresolved migrated criteria";
	if (target.acceptanceCriteria.length === 0) return "no source criteria; invariant workflow requirements apply";
	return `${target.acceptanceCriteria.length} source ${target.acceptanceCriteria.length === 1 ? "criterion" : "criteria"}`;
}

function formatFinalAcceptance(targets: readonly ResolvedImplementationTarget[]): string {
	if (targets.length === 0) return "- <none>";
	return targets
		.map((target) => {
			const heading = `- ${formatTarget(target)}: ${acceptanceSummary(target)}`;
			if (target.acceptanceCriteriaResolved === false || target.acceptanceCriteria.length === 0) return heading;
			return `${heading}\n${target.acceptanceCriteria
				.map((criterion) => `  - [ ] ${criterion.text} (${criterion.id})`)
				.join("\n")}`;
		})
		.join("\n");
}

function formatTarget(target: ResolvedImplementationTarget | undefined): string {
	if (!target) return "<none>";
	const label = target.issueNumber ? `#${target.issueNumber} ${target.title}` : target.title;
	return `${label} [${target.state ?? "unknown"}, ${target.source}]`;
}

function formatIteration(iteration: number, maxIterations?: number): string {
	return maxIterations ? `${iteration}/${maxIterations}` : `${iteration}`;
}

function invalidContext(name: RalphPromptName): Error {
	return new Error(`Invalid context for ${name}`);
}
