import type { FinalizeIssueResult } from "./github";
import type { OrchestrateIssueRun, OrchestratePlan, OrchestrateState } from "./orchestrate-types";
import type { MattRalphState } from "./types";

export type ChildStateSummary = Pick<
	MattRalphState,
	"name" | "status" | "startedAt" | "completedAt" | "initialDirtyStatus" | "ignoredDirtyStatus"
>;

export function formatOrchestratePlan(plan: OrchestratePlan): string {
	return [
		`Parent: #${plan.parent.number} ${plan.parent.title}`,
		`Open children: ${plan.openChildren.length}; skipped closed: ${plan.skippedClosed.length}`,
		plan.skippedClosed.length
			? `Skipped: ${plan.skippedClosed.map((issue) => `#${issue.number}`).join(", ")}`
			: undefined,
		plan.blockers.length
			? `Blockers:\n${plan.blockers.map((blocker) => `- ${blocker.raw}: ${blocker.reason ?? blocker.status}`).join("\n")}`
			: undefined,
		plan.cycles.length
			? `Cycles:\n${plan.cycles.map((cycle) => `- ${cycle.map((issue) => `#${issue}`).join(" -> ")}`).join("\n")}`
			: undefined,
		plan.valid
			? `Planned order:\n${plan.plannedOrder.map((issue, index) => `${index + 1}. #${issue.number} ${issue.title}`).join("\n") || "<none>"}`
			: "Plan invalid; no worker will be launched.",
	]
		.filter(Boolean)
		.join("\n");
}

export function formatOrchestrateStatusLine(input: {
	state: OrchestrateState;
	notePath: string;
	childStatesByName: Map<string, ChildStateSummary>;
	now: string;
}): string {
	const { state, notePath, childStatesByName, now } = input;
	const done = state.issueRuns.filter((run) => run.status === "completed" || run.status === "skipped").length;
	const next = state.issueRuns.find(
		(run) => run.status === "pending" || run.status === "running" || run.status === "failed",
	);
	const current = state.issueRuns.find((run) => run.status === "running") ?? next;
	const last = [...state.issueRuns]
		.reverse()
		.find((run) => run.status === "completed" || run.status === "failed" || run.status === "running");
	const ralphOnlyDirtyCount = countRalphOnlyDirtyRuns(state, childStatesByName);
	const detailLines = [
		current ? `  current: ${formatIssueRunTiming(current, childStatesByName, now)}` : undefined,
		last && last !== current ? `  last: ${formatIssueRunTiming(last, childStatesByName, now)}` : undefined,
		ralphOnlyDirtyCount > 0 ? `  ralph-only dirt: ${ralphOnlyDirtyCount} child session(s)` : undefined,
	]
		.filter(Boolean)
		.join("\n");
	return `- ${state.name}: ${state.status}, ${done}/${state.issueRuns.length}, parent #${state.parentIssue}, duration ${formatDuration(state.startedAt, state.completedAt ?? now)}, next ${next ? `#${next.issue}` : "<none>"}, pane ${state.herdr?.paneId ?? "<none>"}, notes ${notePath}${state.failureReason ? `, reason ${state.failureReason}` : ""}${detailLines ? `\n${detailLines}` : ""}`;
}

export function formatUnsupportedOrchestrateStatusLine(input: { name: string; path: string; reason: string }): string {
	return `- ${input.name}: unsupported schema, ${input.reason}, path ${input.path}`;
}

export function formatInitialOrchestrateNote(state: OrchestrateState): string {
	const plan = state.plan;
	return `# Ralph Orchestration: ${state.name}\n\nStarted: ${state.startedAt}\nParent: #${state.parentIssue} ${state.parentTitle}\nTimeout per issue: ${state.issueTimeoutMs}ms\nSchema version: ${state.schemaVersion}\n\n## Planned order\n\n${plan.plannedOrder.map((issue, index) => `${index + 1}. #${issue.number} ${issue.title}`).join("\n") || "- <none>"}\n\n## Skipped closed children\n\n${plan.skippedClosed.map((issue) => `- #${issue.number} ${issue.title}`).join("\n") || "- <none>"}\n\n## Blockers\n\n${plan.blockers.map((blocker) => `- ${blocker.raw}: ${blocker.reason ?? blocker.status}`).join("\n") || "- <none>"}\n\n## Cycles\n\n${plan.cycles.map((cycle) => `- ${cycle.map((issue) => `#${issue}`).join(" -> ")}`).join("\n") || "- <none>"}\n\n## Progress\n`;
}

export function formatChildRunStartedNote(run: OrchestrateIssueRun): string {
	return `\n\n### Started #${run.issue} ${run.title}\n\nHEAD before: ${run.headBefore}\nWorker session: ${run.sessionName}\n`;
}

export function formatChildRunCompletedNote(run: OrchestrateIssueRun): string {
	return `\nCompleted #${run.issue} at ${run.completedAt}\nWorker exit code: ${run.workerExitCode ?? "<unknown>"}\nRalph runtime: ${formatDuration(run.ralphStartedAt, run.ralphCompletedAt)}\nOrchestrator wait: ${formatDuration(run.startedAt, run.completedAt)}\nHEAD after: ${run.headAfter}\nCommits:\n${(run.commits ?? []).map((commit) => `- ${commit}`).join("\n")}\n`;
}

export function formatChildRunFailedNote(run: OrchestrateIssueRun, paneTail: string): string {
	return `\nFailed #${run.issue}: ${run.error ?? "<unknown>"}\n\nPane tail:\n\`\`\`\n${paneTail}\n\`\`\`\n`;
}

export function formatParentFinalizationNote(finalization: FinalizeIssueResult): string {
	return `\n\n## Parent finalization\n\ncommented=${finalization.commented}, closed=${finalization.closed}${finalization.error ? `, error=${finalization.error}` : ""}\n`;
}

export function formatParentSummary(state: OrchestrateState, completedAt: string): string {
	return `Ralph herdr orchestration completed.\n\nParent: #${state.parentIssue}\nRun: ${state.name}\n\n## Order\n\n${state.issueRuns.map((run, index) => `${index + 1}. #${run.issue} ${run.title} — ${run.status} — commits: ${run.commits?.join(", ") || "<none>"}`).join("\n")}\n\n## Skipped\n\n${state.plan.skippedClosed.map((issue) => `- #${issue.number} ${issue.title}`).join("\n") || "- <none>"}\n\n## Notes\n\n- Worker pane: ${state.herdr?.paneId ?? "<none>"}\n- Started: ${state.startedAt}\n- Completed: ${completedAt}\n`;
}

function formatIssueRunTiming(
	run: OrchestrateIssueRun,
	childStatesByName: Map<string, ChildStateSummary>,
	now: string,
): string {
	const childState = run.sessionName ? childStatesByName.get(run.sessionName) : undefined;
	const sessionName = run.sessionName ?? "<none>";
	const commits = run.commits?.length ?? 0;
	const workerDuration = formatDuration(
		run.workerLaunchedAt ?? run.startedAt,
		run.workerExitedAt ?? run.completedAt ?? (run.status === "running" ? now : undefined),
	);
	const ralphDuration = formatDuration(
		run.ralphStartedAt ?? childState?.startedAt,
		run.ralphCompletedAt ?? childState?.completedAt ?? (childState?.status === "active" ? now : undefined),
	);
	const exitCode = run.workerExitCode ?? "<unknown>";
	return `#${run.issue} ${run.status}, session ${sessionName}, worker ${workerDuration}, ralph ${ralphDuration}, exit ${exitCode}, commits ${commits}`;
}

function countRalphOnlyDirtyRuns(state: OrchestrateState, childStatesByName: Map<string, ChildStateSummary>): number {
	return state.issueRuns.filter((run) => {
		const childState = run.sessionName ? childStatesByName.get(run.sessionName) : undefined;
		return Boolean(
			run.ignoredDirtyStatus ||
				childState?.ignoredDirtyStatus ||
				isRalphOnlyDirtyStatus(run.initialDirtyStatus) ||
				isRalphOnlyDirtyStatus(childState?.initialDirtyStatus),
		);
	}).length;
}

function isRalphOnlyDirtyStatus(status: string | undefined): boolean {
	if (!status) return false;
	const lines = status.split("\n").filter((line) => line.trim().length > 0);
	return lines.length > 0 && lines.every((line) => line.trimEnd().slice(3).startsWith(".ralph/"));
}

function formatDuration(start: string | undefined, end: string | undefined): string {
	if (!start || !end) return "<unknown>";
	const ms = Date.parse(end) - Date.parse(start);
	if (!Number.isFinite(ms) || ms < 0) return "<unknown>";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
