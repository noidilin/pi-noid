import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ChildRunProgress, createChildRunAdapters, runChildIssue, verifyClosedChildRun } from "./child-run";
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
	formatChildRunCompletedNote,
	formatChildRunFailedNote,
	formatChildRunStartedNote,
	formatOrchestratePlan,
	formatOrchestrateStatusLine,
	formatParentFinalizationNote,
	formatParentSummary,
	formatUnsupportedOrchestrateStatusLine,
} from "./orchestrate-projection";
import {
	createOrchestrateState,
	getActiveOrchestration,
	listOrchestrateStateRecords,
	readOrchestrateState,
	requestStop,
	setActiveOrchestration,
	writeOrchestrateState,
} from "./orchestrate-store";
import type { OrchestrateIssueRun, OrchestratePlan, OrchestrateState } from "./orchestrate-types";
import { appendRalphNote, notePathFor, statePathFor } from "./ralph-state-storage";

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
	ctx.ui.notify(formatOrchestratePlan(plan), plan.valid ? "info" : "warning");
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
	ctx.ui.notify(formatOrchestratePlan(plan), plan.valid ? "info" : "warning");
	if (!plan.valid) {
		const state = await createOrchestrateState(ctx.cwd, plan.parent, plan, { issueTimeoutMs: parsed.issueTimeoutMs });
		state.status = "failed";
		state.failureReason = "Plan has blockers or cycles.";
		await writeOrchestrateState(ctx.cwd, state);
		ctx.ui.notify(`Orchestration not started; invalid plan recorded in ${state.name}.`, "warning");
		return;
	}
	if (!parsed.yes && ctx.hasUI) {
		const proceed = await ctx.ui.confirm("Start Ralph orchestration?", formatOrchestratePlan(plan));
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
	const childRunAdapters = createChildRunAdapters(pi, ctx.cwd);
	for (const [index, run] of state.issueRuns.entries()) {
		if (run.status === "completed") continue;
		if (await isIssueClosed(pi, ctx.cwd, run.issue)) {
			const result = await verifyClosedChildRun(
				{
					cwd: ctx.cwd,
					orchestrationName: state.name,
					index,
					run,
					parentIssue: state.parentIssue,
					parentStatePath: statePathFor(ctx.cwd, state.name),
				},
				childRunAdapters,
				async () => {
					await writeOrchestrateState(ctx.cwd, state);
				},
			);
			if (!result.ok) return pause(state, ctx, result.reason);
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
	const allRecords = await listOrchestrateStateRecords(ctx.cwd);
	const requested = args[0]?.replace(/\.state\.json$/, "");
	const records = requested
		? allRecords.filter((record) => (record.kind === "state" ? record.state.name : record.name) === requested)
		: allRecords;
	if (records.length === 0) return ctx.ui.notify("No Ralph orchestrations found in .ralph/.", "info");
	const ralphStatesByName = new Map((await listStates(ctx.cwd)).map((state) => [state.name, state]));
	const now = new Date().toISOString();
	const lines = records.map((record) =>
		record.kind === "state"
			? formatOrchestrateStatusLine({
					state: record.state,
					notePath: notePathFor(ctx.cwd, record.state.name),
					childStatesByName: ralphStatesByName,
					now,
				})
			: formatUnsupportedOrchestrateStatusLine(record),
	);
	ctx.ui.notify(`Ralph orchestrations${active ? ` (active: ${active})` : ""}:\n${lines.join("\n")}`, "info");
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
		const worker = await createWorkerPane(pi, ctx.cwd, focused.paneId, "down");
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
	const completedAt = new Date().toISOString();
	const body = formatParentSummary(state, completedAt);
	const finalization = await finalizeParentIssue(pi, ctx.cwd, state.parentIssue, body);
	await appendRalphNote(ctx.cwd, state.name, formatParentFinalizationNote(finalization));
	if (!finalization.commented || !finalization.closed)
		return pause(state, ctx, finalization.error ?? "Parent finalization failed.");
	state.status = "completed";
	state.completedAt = completedAt;
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
			run,
			parentIssue: state.parentIssue,
			parentStatePath: statePathFor(ctx.cwd, state.name),
			paneId,
			issueTimeoutMs: state.issueTimeoutMs,
		},
		createChildRunAdapters(pi, ctx.cwd),
		async (progress) => {
			await writeOrchestrateState(ctx.cwd, state);
			await recordChildRunProgress(ctx, state, run, progress);
		},
	);
	if (!result.ok) return failRun(ctx, state, run, result.reason, result.diagnostics.paneTail ?? "");
	return true;
}

async function recordChildRunProgress(
	ctx: ExtensionContext,
	state: OrchestrateState,
	run: OrchestrateIssueRun,
	progress: ChildRunProgress,
): Promise<void> {
	if (progress.type === "started") {
		await appendRalphNote(ctx.cwd, state.name, formatChildRunStartedNote(run));
	}
	if (progress.type === "completed") {
		await appendRalphNote(ctx.cwd, state.name, formatChildRunCompletedNote(run));
	}
}

async function failRun(
	ctx: ExtensionContext,
	state: OrchestrateState,
	run: OrchestrateIssueRun,
	error: string,
	paneTail: string,
): Promise<boolean> {
	await appendRalphNote(ctx.cwd, state.name, formatChildRunFailedNote(run, paneTail));
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
