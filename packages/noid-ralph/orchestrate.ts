import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ChildRunProgress, createChildRunAdapters, runChildIssue } from "./child-run";
import {
	dirtyStatusExcludingRalph,
	discoverChildIssuesWithBodies,
	finalizeParentIssue,
	hasCommand,
	isGitRepo,
	isIssueClosed,
	parseIssueNumber,
	viewIssue,
} from "./github";
import { assertInsideHerdr, createWorkerPane, getFocusedPane, sendKeys } from "./herdr-runner";
import { listStates } from "./loop-store";
import { buildOrchestratePlan } from "./orchestrate-planner";
import {
	appendOrchestrateNote,
	createOrchestrateState,
	getActiveOrchestration,
	listOrchestrateStates,
	orchestrateNotePathFor,
	readOrchestrateState,
	requestStop,
	setActiveOrchestration,
	writeOrchestrateState,
} from "./orchestrate-store";
import type { OrchestrateIssueRun, OrchestratePlan, OrchestrateState } from "./orchestrate-types";
import type { MattRalphState } from "./types";

export async function orchestrate(pi: ExtensionAPI, parts: string[], ctx: ExtensionContext): Promise<void> {
	const sub = parts[0];
	try {
		if (sub === "plan") return planCommand(pi, parts.slice(1), ctx);
		if (sub === "start") return startCommand(pi, parts.slice(1), ctx);
		if (sub === "status" || !sub) return statusCommand(ctx, parts.slice(1));
		if (sub === "resume") return resumeCommand(pi, parts.slice(1), ctx);
		if (sub === "stop") return stopCommand(pi, parts.slice(1), ctx);
		ctx.ui.notify("Usage: /ralph orchestrate <plan|start|status|resume|stop>", "warning");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function planCommand(pi: ExtensionAPI, args: string[], ctx: ExtensionContext): Promise<void> {
	const parent = parseParentArg(args[0]);
	if (!parent) return ctx.ui.notify("Usage: /ralph orchestrate plan #<parent>", "warning");
	await preflight(pi, ctx.cwd, false);
	const plan = await fetchPlan(pi, ctx.cwd, parent);
	ctx.ui.notify(formatPlan(plan), plan.valid ? "info" : "warning");
}

async function startCommand(pi: ExtensionAPI, args: string[], ctx: ExtensionContext): Promise<void> {
	assertInsideHerdr();
	const parsed = parseStartArgs(args);
	if (parsed.error || !parsed.parent) {
		ctx.ui.notify(
			parsed.error ?? "Usage: /ralph orchestrate start #<parent> [--yes] [--issue-timeout 2h]",
			"warning",
		);
		return;
	}
	await preflight(pi, ctx.cwd, true);
	const dirty = await dirtyStatusExcludingRalph(pi, ctx.cwd);
	if (dirty) {
		ctx.ui.notify(`Worktree is dirty outside .ralph/**; refusing orchestration.\n${dirty}`, "error");
		return;
	}
	const plan = await fetchPlan(pi, ctx.cwd, parsed.parent);
	ctx.ui.notify(formatPlan(plan), plan.valid ? "info" : "warning");
	if (!plan.valid) {
		const state = await createOrchestrateState(ctx.cwd, plan.parent, plan, { issueTimeoutMs: parsed.issueTimeoutMs });
		state.status = "failed";
		state.failureReason = "Plan has blockers or cycles.";
		await writeOrchestrateState(ctx.cwd, state);
		ctx.ui.notify(`Orchestration not started; invalid plan recorded in ${state.name}.`, "warning");
		return;
	}
	if (!parsed.yes && ctx.hasUI) {
		const proceed = await ctx.ui.confirm("Start Ralph orchestration?", formatPlan(plan));
		if (!proceed) return;
	}
	const state = await createOrchestrateState(ctx.cwd, plan.parent, plan, { issueTimeoutMs: parsed.issueTimeoutMs });
	await runOrchestration(pi, ctx, state);
}

async function resumeCommand(pi: ExtensionAPI, args: string[], ctx: ExtensionContext): Promise<void> {
	assertInsideHerdr();
	const name = args[0] ?? (await getActiveOrchestration(ctx.cwd));
	if (!name) return ctx.ui.notify("Usage: /ralph orchestrate resume <name>", "warning");
	const state = await readOrchestrateState(ctx.cwd, name);
	state.stopRequested = false;
	state.status = "active";
	for (const run of state.issueRuns) {
		if (run.status === "completed") continue;
		if (await isIssueClosed(pi, ctx.cwd, run.issue)) {
			run.status = "completed";
			run.completedAt = new Date().toISOString();
		}
	}
	state.currentIndex = Math.max(
		0,
		state.issueRuns.findIndex((run) => run.status === "pending" || run.status === "failed"),
	);
	if (state.currentIndex < 0) state.currentIndex = state.issueRuns.length;
	await writeOrchestrateState(ctx.cwd, state);
	await runOrchestration(pi, ctx, state);
}

async function statusCommand(ctx: ExtensionContext, args: string[]): Promise<void> {
	const active = await getActiveOrchestration(ctx.cwd);
	const states = args[0] ? [await readOrchestrateState(ctx.cwd, args[0])] : await listOrchestrateStates(ctx.cwd);
	if (states.length === 0) return ctx.ui.notify("No Ralph orchestrations found in .ralph/.", "info");
	const ralphStatesByName = new Map((await listStates(ctx.cwd)).map((state) => [state.name, state]));
	ctx.ui.notify(
		`Ralph orchestrations${active ? ` (active: ${active})` : ""}:\n${states.map((state) => formatStateLine(ctx.cwd, state, ralphStatesByName)).join("\n")}`,
		"info",
	);
}

async function stopCommand(pi: ExtensionAPI, args: string[], ctx: ExtensionContext): Promise<void> {
	const name = args[0] ?? (await getActiveOrchestration(ctx.cwd));
	if (!name) return ctx.ui.notify("Usage: /ralph orchestrate stop <name>", "warning");
	const state = await requestStop(ctx.cwd, name);
	if (state.herdr?.paneId) await sendKeys(pi, ctx.cwd, state.herdr.paneId, "Ctrl-c");
	await setActiveOrchestration(ctx.cwd, undefined);
	ctx.ui.notify(`Stop requested for orchestration: ${state.name}`, "info");
}

async function runOrchestration(pi: ExtensionAPI, ctx: ExtensionContext, state: OrchestrateState): Promise<void> {
	state.status = "active";
	await setActiveOrchestration(ctx.cwd, state.name);
	if (!state.herdr?.paneId) {
		const focused = await getFocusedPane(pi, ctx.cwd);
		const worker = await createWorkerPane(pi, ctx.cwd, focused.paneId, "right");
		state.herdr = {
			workspaceId: worker.workspaceId ?? focused.workspaceId,
			tabId: worker.tabId ?? focused.tabId,
			paneId: worker.paneId,
		};
		await writeOrchestrateState(ctx.cwd, state);
	}
	for (; state.currentIndex < state.issueRuns.length; state.currentIndex += 1) {
		if (state.stopRequested) return pause(state, ctx, "Stop requested.");
		const run = state.issueRuns[state.currentIndex];
		if (!run || run.status === "completed" || run.status === "skipped") continue;
		const result = await runIssueWorker(pi, ctx, state, run, state.currentIndex);
		await writeOrchestrateState(ctx.cwd, state);
		if (!result) return;
	}
	const body = parentSummary(state);
	const finalization = await finalizeParentIssue(pi, ctx.cwd, state.parentIssue, body);
	await appendOrchestrateNote(
		ctx.cwd,
		state,
		`\n\n## Parent finalization\n\ncommented=${finalization.commented}, closed=${finalization.closed}${finalization.error ? `, error=${finalization.error}` : ""}\n`,
	);
	if (!finalization.commented || !finalization.closed)
		return pause(state, ctx, finalization.error ?? "Parent finalization failed.");
	state.status = "completed";
	state.completedAt = new Date().toISOString();
	await writeOrchestrateState(ctx.cwd, state);
	await setActiveOrchestration(ctx.cwd, undefined);
	ctx.ui.notify(`Ralph orchestration completed: ${state.name}`, "info");
}

async function runIssueWorker(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: OrchestrateState,
	run: OrchestrateIssueRun,
	index: number,
): Promise<boolean> {
	const paneId = state.herdr?.paneId;
	if (!paneId) throw new Error("Missing herdr worker pane id.");
	const result = await runChildIssue(
		{
			cwd: ctx.cwd,
			orchestrationName: state.name,
			index,
			issue: run.issue,
			title: run.title,
			paneId,
			issueTimeoutMs: state.issueTimeoutMs,
		},
		createChildRunAdapters(pi, ctx.cwd),
		async (progress) => {
			applyChildRunProgress(run, progress);
			await recordChildRunProgress(ctx, state, run, progress);
			await writeOrchestrateState(ctx.cwd, state);
		},
	);
	if (!result.ok) return failRun(ctx, state, run, result.reason, result.diagnostics.paneTail ?? "");
	return true;
}

function applyChildRunProgress(run: OrchestrateIssueRun, progress: ChildRunProgress): void {
	if (progress.type === "started") {
		run.status = "running";
		run.startedAt = progress.facts.startedAt;
		run.headBefore = progress.facts.headBefore;
		run.sessionName = progress.facts.sessionName;
		return;
	}
	if (progress.type === "workerScriptWritten") {
		run.workerScript = progress.facts.workerScript;
		return;
	}
	if (progress.type === "workerLaunched") {
		run.workerLaunchedAt = progress.facts.workerLaunchedAt;
		return;
	}
	if (progress.type === "workerExited") {
		run.workerExitedAt = progress.facts.workerExitedAt;
		run.workerExitCode = progress.facts.workerExitCode;
		return;
	}
	if (progress.type === "childStateRead") {
		run.ralphStartedAt = progress.facts.ralphStartedAt;
		run.ralphCompletedAt = progress.facts.ralphCompletedAt;
		run.initialDirtyStatus = progress.facts.initialDirtyStatus;
		run.ignoredDirtyStatus = progress.facts.ignoredDirtyStatus;
		return;
	}
	if (progress.type === "completed") {
		run.status = "completed";
		run.completedAt = progress.facts.completedAt;
		run.headAfter = progress.facts.headAfter;
		run.commits = progress.facts.commits;
		return;
	}
	if (progress.type === "failed") {
		run.status = "failed";
		run.error = progress.reason;
	}
}

async function recordChildRunProgress(
	ctx: ExtensionContext,
	state: OrchestrateState,
	run: OrchestrateIssueRun,
	progress: ChildRunProgress,
): Promise<void> {
	if (progress.type === "started") {
		await appendOrchestrateNote(
			ctx.cwd,
			state,
			`\n\n### Started #${run.issue} ${run.title}\n\nHEAD before: ${run.headBefore}\nWorker session: ${run.sessionName}\n`,
		);
	}
	if (progress.type === "completed") {
		await appendOrchestrateNote(
			ctx.cwd,
			state,
			`\nCompleted #${run.issue} at ${run.completedAt}\nWorker exit code: ${run.workerExitCode ?? "<unknown>"}\nRalph runtime: ${formatDuration(run.ralphStartedAt, run.ralphCompletedAt)}\nOrchestrator wait: ${formatDuration(run.startedAt, run.completedAt)}\nHEAD after: ${run.headAfter}\nCommits:\n${(run.commits ?? []).map((commit) => `- ${commit}`).join("\n")}\n`,
		);
	}
}

async function failRun(
	ctx: ExtensionContext,
	state: OrchestrateState,
	run: OrchestrateIssueRun,
	error: string,
	paneTail: string,
): Promise<boolean> {
	run.status = "failed";
	run.error = error;
	await appendOrchestrateNote(
		ctx.cwd,
		state,
		`\nFailed #${run.issue}: ${error}\n\nPane tail:\n\`\`\`\n${paneTail}\n\`\`\`\n`,
	);
	await pause(state, ctx, error);
	return false;
}

async function pause(state: OrchestrateState, ctx: ExtensionContext, reason: string): Promise<void> {
	state.status = state.stopRequested ? "stopped" : "paused";
	state.failureReason = reason;
	await writeOrchestrateState(ctx.cwd, state);
	await setActiveOrchestration(ctx.cwd, undefined);
	ctx.ui.notify(`Ralph orchestration paused: ${reason}`, "warning");
}

async function fetchPlan(pi: ExtensionAPI, cwd: string, parent: number): Promise<OrchestratePlan> {
	const parentIssue = await viewIssue(pi, cwd, parent);
	if (!parentIssue) throw new Error(`Could not fetch parent issue #${parent}.`);
	const children = await discoverChildIssuesWithBodies(pi, cwd, parent);
	return buildOrchestratePlan({
		parent: { number: parentIssue.number, title: parentIssue.title, url: parentIssue.url },
		children,
		resolveExternalIssue: (issue) => viewIssue(pi, cwd, issue),
	});
}

async function preflight(pi: ExtensionAPI, cwd: string, requireHerdr: boolean): Promise<void> {
	if (requireHerdr) assertInsideHerdr();
	if (!(await hasCommand(pi, "gh", cwd))) throw new Error("gh is required for Ralph orchestration.");
	if (!(await hasCommand(pi, "git", cwd))) throw new Error("git is required for Ralph orchestration.");
	if (!(await isGitRepo(pi, cwd))) throw new Error("Ralph orchestration requires a git repository.");
}

function parseParentArg(value: string | undefined): number | undefined {
	return value ? parseIssueNumber(value) : undefined;
}

function parseStartArgs(args: string[]): { parent?: number; yes: boolean; issueTimeoutMs: number; error?: string } {
	let parent: number | undefined;
	let yes = false;
	let issueTimeoutMs = 2 * 60 * 60 * 1000;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--yes") yes = true;
		else if (arg === "--issue-timeout") {
			const duration = parseDuration(args[index + 1]);
			if (!duration) return { yes, issueTimeoutMs, error: "--issue-timeout requires a duration like 30m or 2h." };
			issueTimeoutMs = duration;
			index += 1;
		} else if (!parent) parent = parseParentArg(arg);
		else return { parent, yes, issueTimeoutMs, error: `Unknown argument: ${arg}` };
	}
	return { parent, yes, issueTimeoutMs };
}

function parseDuration(value: string | undefined): number | undefined {
	const match = value?.match(/^(\d+)(ms|s|m|h)?$/);
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2] ?? "ms";
	const scale = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
	return amount > 0 ? amount * scale : undefined;
}

function formatPlan(plan: OrchestratePlan): string {
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

function formatStateLine(cwd: string, state: OrchestrateState, ralphStatesByName: Map<string, MattRalphState>): string {
	const done = state.issueRuns.filter((run) => run.status === "completed" || run.status === "skipped").length;
	const next = state.issueRuns.find(
		(run) => run.status === "pending" || run.status === "running" || run.status === "failed",
	);
	const current = state.issueRuns.find((run) => run.status === "running") ?? next;
	const last = [...state.issueRuns]
		.reverse()
		.find((run) => run.status === "completed" || run.status === "failed" || run.status === "running");
	const ralphOnlyDirtyCount = countRalphOnlyDirtyRuns(state, ralphStatesByName);
	const detailLines = [
		current ? `  current: ${formatIssueRunTiming(current, ralphStatesByName)}` : undefined,
		last && last !== current ? `  last: ${formatIssueRunTiming(last, ralphStatesByName)}` : undefined,
		ralphOnlyDirtyCount > 0 ? `  ralph-only dirt: ${ralphOnlyDirtyCount} child session(s)` : undefined,
	]
		.filter(Boolean)
		.join("\n");
	return `- ${state.name}: ${state.status}, ${done}/${state.issueRuns.length}, parent #${state.parentIssue}, duration ${formatDuration(state.startedAt, state.completedAt ?? new Date().toISOString())}, next ${next ? `#${next.issue}` : "<none>"}, pane ${state.herdr?.paneId ?? "<none>"}, notes ${orchestrateNotePathFor(cwd, state.name)}${state.failureReason ? `, reason ${state.failureReason}` : ""}${detailLines ? `\n${detailLines}` : ""}`;
}

function formatIssueRunTiming(run: OrchestrateIssueRun, ralphStatesByName: Map<string, MattRalphState>): string {
	const childState = run.sessionName ? ralphStatesByName.get(run.sessionName) : undefined;
	const sessionName = run.sessionName ?? "<none>";
	const commits = run.commits?.length ?? 0;
	const now = new Date().toISOString();
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

function countRalphOnlyDirtyRuns(state: OrchestrateState, ralphStatesByName: Map<string, MattRalphState>): number {
	return state.issueRuns.filter((run) => {
		const childState = run.sessionName ? ralphStatesByName.get(run.sessionName) : undefined;
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

function parentSummary(state: OrchestrateState): string {
	return `Ralph herdr orchestration completed.\n\nParent: #${state.parentIssue}\nRun: ${state.name}\n\n## Order\n\n${state.issueRuns.map((run, index) => `${index + 1}. #${run.issue} ${run.title} — ${run.status} — commits: ${run.commits?.join(", ") || "<none>"}`).join("\n")}\n\n## Skipped\n\n${state.plan.skippedClosed.map((issue) => `- #${issue.number} ${issue.title}`).join("\n") || "- <none>"}\n\n## Notes\n\n- Worker pane: ${state.herdr?.paneId ?? "<none>"}\n- Started: ${state.startedAt}\n- Completed: ${new Date().toISOString()}\n`;
}
