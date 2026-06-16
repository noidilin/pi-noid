import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { FinalizeIssueResult } from "./github";
import {
	dirtyStatus,
	dirtyStatusExcludingRalph,
	discoverChildren,
	extractParentFromBody,
	finalizeIssue,
	hasCommand,
	isGitRepo,
	parseIssueNumber,
	viewIssue,
} from "./github";
import {
	appendTaskNote,
	archiveState,
	deleteState,
	deleteTask,
	ensureStore,
	getActiveState,
	listArchivedStates,
	listStates,
	ralphDir,
	readState,
	sanitizeSessionName,
	setActiveSession,
	taskPathFor,
	writeState,
} from "./loop-store";
import { orchestrate } from "./orchestrate";
import {
	buildFinalPrompt,
	buildKickoffPrompt,
	buildNextPrompt,
	buildResumePrompt,
	buildSystemInjection,
} from "./prompt";
import { type ChildIssue, MATT_RALPH_SCHEMA_VERSION, type MattRalphState, type TargetDescriptor } from "./types";

const REQUIRED_SKILLS = ["tdd", "diagnose", "grill-with-docs"];

export default function mattRalphExtension(pi: ExtensionAPI) {
	let currentCwd = process.cwd();

	pi.registerCommand("ralph", {
		description:
			"Matt Pocock-style workflows. Use: /ralph <implement|orchestrate|status|resume|stop|cancel|archive|clean|list>",
		argumentHint:
			"implement <issue-or-prd> [--max-iterations N] | orchestrate <plan|start|status|resume|stop> | status | resume <session> | stop",
		getArgumentCompletions: async (argumentPrefix: string) => getRalphCompletions(argumentPrefix, currentCwd),
		handler: async (args: string, ctx: ExtensionContext) => {
			currentCwd = ctx.cwd;
			await handleRalphCommand(pi, args, ctx);
		},
	} as any);

	pi.registerTool({
		name: "matt_ralph_done",
		label: "Matt Ralph Done",
		description:
			"Advance the active Matt Ralph implementation loop after the current target is implemented, tested, committed, and notes are updated.",
		promptSnippet: "Advance the active Matt Ralph implementation loop to the next target.",
		promptGuidelines: [
			"Use matt_ralph_done only after the current Matt Ralph target is implemented, validated, locally committed, and .ralph notes are updated.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (ctx.hasPendingMessages()) {
				return {
					content: [{ type: "text", text: "Pending messages already queued. Skipping matt_ralph_done." }],
					details: {},
				};
			}
			const state = await getActiveState(ctx.cwd);
			if (!state) {
				return { content: [{ type: "text", text: "No active Matt Ralph session found." }], details: {} };
			}

			state.iteration += 1;
			state.currentIndex += 1;
			state.lastAdvancedAt = new Date().toISOString();
			await appendTaskNote(
				ctx.cwd,
				state,
				`\n\n## Iteration ${state.iteration - 1} advanced\n\nAdvanced at ${state.lastAdvancedAt}.\n`,
			);

			if (state.maxIterations && state.iteration > state.maxIterations) {
				state.status = "paused";
				state.warnings = [
					...(state.warnings ?? []),
					`Paused after exceeding maxIterations=${state.maxIterations}.`,
				];
				await writeState(ctx.cwd, state);
				await setActiveSession(ctx.cwd, undefined);
				updateMattRalphUI(ctx, undefined);
				emitMattEvent(pi, "matt_ralph:pause", { name: state.name });
				return {
					content: [
						{
							type: "text",
							text: `Matt Ralph paused after exceeding max iterations (${state.maxIterations}). No more work queued.`,
						},
					],
					details: { state },
				};
			}

			await writeState(ctx.cwd, state);
			emitMattEvent(pi, "matt_ralph:advance", eventPayload(state));
			updateMattRalphUI(ctx, state);

			if (state.currentIndex >= state.childIssues.length) {
				pi.sendUserMessage(buildFinalPrompt(state), { deliverAs: "followUp" });
				return {
					content: [{ type: "text", text: "All Matt Ralph targets processed. Queued final verification prompt." }],
					details: { state },
				};
			}

			pi.sendUserMessage(buildNextPrompt(state), { deliverAs: "followUp" });
			return {
				content: [
					{
						type: "text",
						text: `Advanced Matt Ralph to target ${state.currentIndex + 1}/${state.childIssues.length}.`,
					},
				],
				details: { state },
			};
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = await getActiveState(ctx.cwd);
		if (!state) return;
		return { systemPrompt: event.systemPrompt + buildSystemInjection(state) };
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const text = JSON.stringify(event.message);
		if (!text.includes("MATT_RALPH_COMPLETE")) return;
		const state = await getActiveState(ctx.cwd);
		if (!state) return;
		const finalization = await finalizeGithubIssues(pi, ctx, state);
		state.status = "completed";
		state.completedAt = new Date().toISOString();
		await writeState(ctx.cwd, state);
		await setActiveSession(ctx.cwd, undefined);
		updateMattRalphUI(ctx, undefined);
		emitMattEvent(pi, "matt_ralph:complete", { name: state.name, iteration: state.iteration, finalization });
		ctx.ui.notify(
			formatCompletionNotice(state.name, finalization),
			finalization.failed.length > 0 ? "warning" : "info",
		);
		if (state.exitOnComplete) (ctx as { shutdown?: () => void }).shutdown?.();
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCwd = ctx.cwd;
		const state = await getActiveState(ctx.cwd);
		updateMattRalphUI(ctx, state);
	});
}

async function getRalphCompletions(argumentPrefix: string, cwd: string): Promise<AutocompleteItem[] | null> {
	const commands: AutocompleteItem[] = [
		{
			value: "implement ",
			label: "implement",
			description: "Start an implementation loop for an issue or PRD",
		},
		{
			value: "implement # --max-iterations ",
			label: "implement --max-iterations",
			description: "Start with a safety iteration cap",
		},
		{ value: "orchestrate plan #", label: "orchestrate plan", description: "Plan a parent issue orchestration" },
		{
			value: "orchestrate start #",
			label: "orchestrate start",
			description: "Run child issues sequentially in herdr",
		},
		{ value: "orchestrate status", label: "orchestrate status", description: "List Ralph orchestrations" },
		{ value: "status", label: "status", description: "List Matt Ralph sessions in .ralph/" },
		{ value: "list", label: "list", description: "Alias for status" },
		{
			value: "list --archived",
			label: "list --archived",
			description: "List archived Matt Ralph sessions",
		},
		{ value: "resume ", label: "resume", description: "Resume a paused or existing Matt Ralph session" },
		{ value: "stop", label: "stop", description: "Pause the active Matt Ralph session" },
		{ value: "cancel ", label: "cancel", description: "Cancel a session; leaves notes intact" },
		{ value: "archive ", label: "archive", description: "Archive a paused or completed session" },
		{ value: "clean", label: "clean", description: "Delete completed session state files" },
		{ value: "clean --all", label: "clean --all", description: "Delete completed states and notes" },
	];
	const hasTrailingSpace = /\s$/.test(argumentPrefix);
	const trimmed = argumentPrefix.trim();
	const parts = trimmed ? trimmed.split(/\s+/) : [];

	if (parts.length === 0) return commands;
	if (parts.length === 1 && !hasTrailingSpace) {
		const prefix = parts[0]?.toLowerCase() ?? "";
		const matches = commands.filter((item) => item.label.startsWith(prefix));
		return matches.length > 0 ? matches : null;
	}

	const subcommand = parts[0];
	if (["resume", "cancel", "archive"].includes(subcommand) && (parts.length === 1 || parts.length === 2)) {
		const completedPrefix = hasTrailingSpace ? "" : (parts[1] ?? "");
		const states = await listStates(cwd);
		const matches = states
			.filter((state) => state.name.toLowerCase().startsWith(completedPrefix.toLowerCase()))
			.map((state) => ({
				value: `${subcommand} ${state.name}`,
				label: state.name,
				description: `${state.status}, ${Math.min(state.currentIndex + 1, state.childIssues.length)}/${state.childIssues.length}`,
			}));
		return matches.length > 0 ? matches : null;
	}

	if (subcommand === "implement" && (parts.length === 1 || parts.length === 2)) {
		return [
			{ value: "implement #", label: "#<issue>", description: "Implement a GitHub issue or parent PRD issue" },
			{
				value: "implement docs/prd/",
				label: "docs/prd/",
				description: "Implement from a local PRD markdown file",
			},
			{ value: "implement --max-iterations ", label: "--max-iterations", description: "Set a safety cap" },
		];
	}

	return null;
}

async function handleRalphCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	const parts = splitArgs(args);
	const sub = parts[0];
	if (sub === "implement") return implement(pi, parts.slice(1).join(" "), ctx);
	if (sub === "orchestrate") return orchestrate(pi, parts.slice(1), ctx);
	if (sub === "status" || sub === "ls") return status(ctx);
	if (sub === "list") return parts.includes("--archived") ? listArchived(ctx) : status(ctx);
	if (sub === "resume") return resume(pi, parts.slice(1).join(" "), ctx);
	if (sub === "stop") return stop(pi, ctx);
	if (sub === "cancel") return cancel(pi, parts.slice(1).join(" "), ctx);
	if (sub === "archive") return archive(pi, parts.slice(1).join(" "), ctx);
	if (sub === "clean") return clean(parts.includes("--all"), ctx);
	ctx.ui.notify("Usage: /ralph <implement|status|resume|stop|cancel|archive|clean|list>", "warning");
}

async function implement(pi: ExtensionAPI, rawTarget: string, ctx: ExtensionContext): Promise<void> {
	const parsed = parseImplementArgs(rawTarget);
	if (parsed.error) {
		ctx.ui.notify(parsed.error, "warning");
		return;
	}
	const targetArg = parsed.target;
	if (!targetArg) {
		ctx.ui.notify(
			"Usage: /ralph implement <issue-or-prd> [--max-iterations N] [--exit-on-complete] [--session-suffix suffix]",
			"warning",
		);
		return;
	}

	if (!(await isGitRepo(pi, ctx.cwd))) {
		ctx.ui.notify("Matt Ralph requires running inside a git repository.", "error");
		return;
	}

	const target = describeTarget(ctx.cwd, targetArg);
	if (target.kind === "path" && !existsSync(path.resolve(ctx.cwd, target.path))) {
		ctx.ui.notify(`Target file not found: ${target.path}`, "error");
		return;
	}

	const rawDirtyStatus = await dirtyStatus(pi, ctx.cwd);
	const initialDirtyStatus = parsed.ignoreRalphDirty ? await dirtyStatusExcludingRalph(pi, ctx.cwd) : rawDirtyStatus;
	const ignoredDirtyStatus = parsed.ignoreRalphDirty ? ralphOnlyDirtyStatus(rawDirtyStatus) : undefined;
	if (initialDirtyStatus && ctx.hasUI) {
		const proceed = await ctx.ui.confirm(
			"Dirty worktree",
			`git status --porcelain is not clean. Proceed and record the dirty state in .ralph notes?\n\n${initialDirtyStatus}`,
		);
		if (!proceed) return;
	}

	const warnings = await preflightWarnings(pi, ctx.cwd, target);
	for (const warning of warnings) ctx.ui.notify(warning, "warning");

	const { parentIssue, children } = await resolveTargets(pi, ctx.cwd, target);
	const baseName = `implement-${sanitizeSessionName(targetArg)}`;
	const name = parsed.sessionSuffix ? `${baseName}-${sanitizeSessionName(parsed.sessionSuffix)}` : baseName;
	const taskFileAbs = taskPathFor(ctx.cwd, name);
	const taskFileRel = path.relative(ctx.cwd, taskFileAbs);
	const state: MattRalphState = {
		schemaVersion: MATT_RALPH_SCHEMA_VERSION,
		name,
		taskFile: taskFileRel,
		status: "active",
		mode: "implement",
		rootIssue: targetArg,
		parentIssue,
		childIssues: children,
		currentIndex: 0,
		iteration: 1,
		startedAt: new Date().toISOString(),
		initialDirtyStatus,
		ignoredDirtyStatus,
		warnings,
		maxIterations: parsed.maxIterations,
		exitOnComplete: parsed.exitOnComplete,
		sessionSuffix: parsed.sessionSuffix,
		orchestratorName: parsed.orchestrationChildLink?.orchestrationName,
		orchestrationChildLink: parsed.orchestrationChildLink,
	};

	await ensureStore(ctx.cwd);
	await mkdir(ralphDir(ctx.cwd), { recursive: true });
	await writeFile(taskFileAbs, initialTaskFile(state), "utf8");
	await writeState(ctx.cwd, state);
	await setActiveSession(ctx.cwd, name);
	updateMattRalphUI(ctx, state);
	emitMattEvent(pi, "matt_ralph:start", eventPayload(state));
	ctx.ui.notify(`Matt Ralph session created: ${taskFileRel}`, "info");
	pi.sendUserMessage(buildKickoffPrompt(state));
}

async function status(ctx: ExtensionContext): Promise<void> {
	const states = await listStates(ctx.cwd);
	if (states.length === 0) {
		ctx.ui.notify("No Matt Ralph sessions found in .ralph/.", "info");
		return;
	}
	const lines = states.map(formatStateLine);
	ctx.ui.notify(`Matt Ralph sessions:\n${lines.join("\n")}`, "info");
}

async function listArchived(ctx: ExtensionContext): Promise<void> {
	const states = await listArchivedStates(ctx.cwd);
	if (states.length === 0) {
		ctx.ui.notify("No archived Matt Ralph sessions found in .ralph/archive/.", "info");
		return;
	}
	ctx.ui.notify(`Archived Matt Ralph sessions:\n${states.map(formatStateLine).join("\n")}`, "info");
}

async function resume(pi: ExtensionAPI, sessionArg: string, ctx: ExtensionContext): Promise<void> {
	const states = await listStates(ctx.cwd);
	if (states.length === 0) {
		ctx.ui.notify("No Matt Ralph sessions found in .ralph/.", "warning");
		return;
	}
	const name = sessionArg.trim() || states.find((state) => state.status === "paused")?.name || states[0]?.name;
	if (!name) return;
	let state: MattRalphState;
	try {
		state = await readState(ctx.cwd, name.replace(/\.state\.json$/, ""));
	} catch {
		ctx.ui.notify(`Matt Ralph session not found: ${name}`, "error");
		return;
	}
	state.status = "active";
	state.lastResumedAt = new Date().toISOString();
	await writeState(ctx.cwd, state);
	await setActiveSession(ctx.cwd, state.name);
	updateMattRalphUI(ctx, state);
	pi.sendUserMessage(buildResumePrompt(state));
}

async function stop(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const state = await getActiveState(ctx.cwd);
	if (!state) {
		ctx.ui.notify("No active Matt Ralph session.", "info");
		return;
	}
	state.status = "paused";
	await writeState(ctx.cwd, state);
	await setActiveSession(ctx.cwd, undefined);
	updateMattRalphUI(ctx, undefined);
	emitMattEvent(pi, "matt_ralph:pause", { name: state.name });
	ctx.ui.notify(`Paused Matt Ralph session: ${state.name}`, "info");
}

async function cancel(pi: ExtensionAPI, sessionArg: string, ctx: ExtensionContext): Promise<void> {
	const name = sessionArg.trim();
	if (!name) {
		ctx.ui.notify("Usage: /ralph cancel <session>", "warning");
		return;
	}
	try {
		await readState(ctx.cwd, name);
	} catch {
		ctx.ui.notify(`Matt Ralph session not found: ${name}`, "error");
		return;
	}
	await deleteState(ctx.cwd, name);
	updateMattRalphUI(ctx, await getActiveState(ctx.cwd));
	emitMattEvent(pi, "matt_ralph:cancel", { name });
	ctx.ui.notify(`Cancelled Matt Ralph session state: ${name}. Notes file left intact.`, "info");
}

async function archive(pi: ExtensionAPI, sessionArg: string, ctx: ExtensionContext): Promise<void> {
	const name = sessionArg.trim();
	if (!name) {
		ctx.ui.notify("Usage: /ralph archive <session>", "warning");
		return;
	}
	let state: MattRalphState;
	try {
		state = await readState(ctx.cwd, name);
	} catch {
		ctx.ui.notify(`Matt Ralph session not found: ${name}`, "error");
		return;
	}
	if (state.status === "active") {
		ctx.ui.notify(`Cannot archive active session ${name}; stop it first.`, "warning");
		return;
	}
	await archiveState(ctx.cwd, state);
	emitMattEvent(pi, "matt_ralph:archive", { name });
	ctx.ui.notify(`Archived Matt Ralph session: ${name}`, "info");
}

async function clean(all: boolean, ctx: ExtensionContext): Promise<void> {
	const states = (await listStates(ctx.cwd)).filter((state) => state.status === "completed");
	for (const state of states) {
		await deleteState(ctx.cwd, state.name);
		if (all) await deleteTask(ctx.cwd, state);
	}
	if (states.length === 0) {
		ctx.ui.notify("No completed Matt Ralph sessions to clean.", "info");
		return;
	}
	ctx.ui.notify(
		`Cleaned ${states.length} completed Matt Ralph session(s):\n${states.map((state) => `- ${state.name}`).join("\n")}`,
		"info",
	);
}

function describeTarget(cwd: string, raw: string): TargetDescriptor {
	const issueNumber = parseIssueNumber(raw);
	if (issueNumber) return { kind: "github", raw, number: issueNumber };
	const resolved = path.resolve(cwd, raw);
	if (existsSync(resolved) || raw.includes("/") || raw.endsWith(".md")) return { kind: "path", raw, path: raw };
	return { kind: "text", raw };
}

async function resolveTargets(
	pi: ExtensionAPI,
	cwd: string,
	target: TargetDescriptor,
): Promise<{ parentIssue?: number; children: ChildIssue[] }> {
	if (target.kind !== "github") {
		return { children: [{ number: 0, title: target.raw, source: "standalone" }] };
	}

	const issue = await viewIssue(pi, cwd, target.number);
	const title = issue?.title ?? `Issue #${target.number}`;
	const parentIssue = issue?.parent?.number ?? extractParentFromBody(issue?.body);
	if (parentIssue) {
		return {
			parentIssue,
			children: [{ number: target.number, title, state: issue?.state, source: "standalone" }],
		};
	}

	const children = await discoverChildren(pi, cwd, target.number);
	if (children.length > 0) return { parentIssue: target.number, children };
	return {
		parentIssue: target.number,
		children: [{ number: target.number, title, state: issue?.state, source: "standalone" }],
	};
}

async function preflightWarnings(pi: ExtensionAPI, cwd: string, target: TargetDescriptor): Promise<string[]> {
	const warnings: string[] = [];
	if (target.kind === "github" && !(await hasCommand(pi, "gh", cwd))) {
		warnings.push(
			"GitHub issue target detected, but gh is not available. Install/auth gh before agent issue fetches.",
		);
	}
	for (const skill of REQUIRED_SKILLS) {
		if (!existsSync(`/Users/noid/.agents/skills/${skill}`))
			warnings.push(`Matt skill not found: ${skill}. Configure/install Matt skills if the agent needs it.`);
	}
	const hasAgentDocs = ["AGENTS.md", "CLAUDE.md", "docs/agents"].some((entry) => existsSync(path.join(cwd, entry)));
	if (!hasAgentDocs)
		warnings.push(
			"No AGENTS.md, CLAUDE.md, or docs/agents/ found. Consider running the Matt setup skill; extension will not mutate settings.",
		);
	return warnings;
}

function formatStateLine(state: MattRalphState): string {
	const target = state.childIssues[state.currentIndex];
	const current = target ? formatTargetLabel(target) : "<final verification>";
	const progress = `${Math.min(state.currentIndex + 1, state.childIssues.length)}/${state.childIssues.length}`;
	const iteration = state.maxIterations ? `${state.iteration}/${state.maxIterations}` : `${state.iteration}`;
	const completed = state.completedAt ? `, completed ${state.completedAt}` : "";
	const archived = state.archivedAt ? `, archived ${state.archivedAt}` : "";
	return `- ${state.name}: ${state.status}, target ${progress}, iteration ${iteration}, ${current}, notes ${state.taskFile}${completed}${archived}`;
}

function updateMattRalphUI(ctx: ExtensionContext, state: MattRalphState | undefined): void {
	const ui = ctx.ui as {
		theme?: { fg?: (color: string, text: string) => string };
		setWidget?: (key: string, widget?: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
	};
	if (state?.status !== "active" || !Array.isArray(state.childIssues)) {
		ctx.ui.setStatus("matt-ralph", undefined);
		ui.setWidget?.("matt-ralph", undefined);
		return;
	}
	const progress = `${Math.min(state.currentIndex + 1, state.childIssues.length)}/${state.childIssues.length}`;
	ctx.ui.setStatus("matt-ralph", `matt ● ${progress} i${formatIteration(state)}`);
	ui.setWidget?.("matt-ralph", (_tui: unknown, theme: RalphTheme) => createRalphCard(state, theme), {
		placement: "aboveEditor",
	});
}

type RalphTheme = {
	fg(color: string, text: string): string;
	bold?(text: string): string;
};

function createRalphCard(state: MattRalphState, theme: RalphTheme) {
	return {
		render(width: number): string[] {
			const cardWidth = Math.min(width, 72);
			if (cardWidth < 4) return [];
			const innerWidth = Math.max(0, cardWidth - 4);
			const target = state.childIssues[state.currentIndex];
			const progress = `${Math.min(state.currentIndex + 1, state.childIssues.length)}/${state.childIssues.length}`;
			const warningCount = state.warnings?.length ?? 0;
			const badges = [
				warningCount > 0 ? theme.fg("warning", `⚠${warningCount}`) : undefined,
				state.initialDirtyStatus ? theme.fg("warning", "dirty") : undefined,
			]
				.filter(Boolean)
				.join(" ");
			const status = theme.fg("success", "● active");
			const rows = [
				`${status}  target ${progress}  iter ${formatIteration(state)}${badges ? `  ${badges}` : ""}`,
				`Now: ${target ? formatTargetLabel(target) : "<final verification>"}`,
				`Next: ${formatUpcomingTargets(state)}`,
				`Notes: ${state.taskFile}`,
				"Policy: local commit · never push · GH finalizes",
				"Hints: stop · status · archive",
			];
			return [
				cardBorder("top", cardWidth, theme, "Matt Ralph"),
				...rows.map((row) => cardRow(row, innerWidth, theme)),
				cardBorder("bottom", cardWidth, theme),
			];
		},
		invalidate(): void {},
	};
}

function formatUpcomingTargets(state: MattRalphState): string {
	const upcoming = state.childIssues
		.slice(state.currentIndex + 1)
		.map((issue) => (issue.number > 0 ? `#${issue.number}` : issue.title));
	if (upcoming.length === 0) return "<final verification>";
	return upcoming.join(" ");
}

function formatIteration(state: MattRalphState): string {
	return state.maxIterations ? `${state.iteration}/${state.maxIterations}` : `${state.iteration}`;
}

function cardBorder(kind: "top" | "bottom", width: number, theme: RalphTheme, title?: string): string {
	if (width < 4) return theme.fg("accent", "─".repeat(width));
	if (kind === "bottom") return theme.fg("accent", `╰${"─".repeat(width - 2)}╯`);
	const label = title ? `─ ${title} ` : "";
	return theme.fg("accent", `╭${label}${"─".repeat(Math.max(0, width - visibleWidth(label) - 2))}╮`);
}

function cardRow(text: string, innerWidth: number, theme: RalphTheme): string {
	const content = padVisible(truncateToWidth(text, innerWidth, "…"), innerWidth);
	return `${theme.fg("accent", "│")} ${content} ${theme.fg("accent", "│")}`;
}

function padVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function emitMattEvent(pi: ExtensionAPI, name: string, payload: Record<string, unknown>): void {
	pi.events.emit(name, payload);
}

type FinalizationSummary = {
	succeeded: FinalizeIssueResult[];
	failed: FinalizeIssueResult[];
	skipped: string[];
};

async function finalizeGithubIssues(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: MattRalphState,
): Promise<FinalizationSummary> {
	const issueNumbers = githubIssueNumbersFor(state);
	if (issueNumbers.length === 0) {
		const skipped = ["No GitHub issue targets in this session."];
		await appendTaskNote(ctx.cwd, state, finalizationNote([], [], skipped));
		return { succeeded: [], failed: [], skipped };
	}
	if (!(await hasCommand(pi, "gh", ctx.cwd))) {
		const skipped = ["gh is not available; skipped final GitHub issue comment/close."];
		await appendTaskNote(ctx.cwd, state, finalizationNote([], [], skipped));
		return { succeeded: [], failed: [], skipped };
	}

	const results: FinalizeIssueResult[] = [];
	for (const issue of issueNumbers) results.push(await finalizeIssue(pi, ctx.cwd, issue));
	const succeeded = results.filter((result) => result.commented && result.closed);
	const failed = results.filter((result) => !result.commented || !result.closed);
	await appendTaskNote(ctx.cwd, state, finalizationNote(succeeded, failed, []));
	return { succeeded, failed, skipped: [] };
}

function githubIssueNumbersFor(state: MattRalphState): number[] {
	const issues = state.childIssues.map((issue) => issue.number).filter((issue) => issue > 0);
	const rootIssue = parseIssueNumber(state.rootIssue);
	if (state.parentIssue && rootIssue === state.parentIssue) issues.push(state.parentIssue);
	return [...new Set(issues)];
}

function finalizationNote(succeeded: FinalizeIssueResult[], failed: FinalizeIssueResult[], skipped: string[]): string {
	const lines = ["", "", "## GitHub finalization", "", `Completed at ${new Date().toISOString()}.`, ""];
	if (succeeded.length > 0) {
		lines.push("### Commented and closed", "", ...succeeded.map((result) => `- #${result.issue}`), "");
	}
	if (failed.length > 0) {
		lines.push(
			"### Failed",
			"",
			...failed.map(
				(result) =>
					`- #${result.issue}: commented=${result.commented}, closed=${result.closed}${result.error ? `, error=${result.error}` : ""}`,
			),
			"",
		);
	}
	if (skipped.length > 0) lines.push("### Skipped", "", ...skipped.map((reason) => `- ${reason}`), "");
	return lines.join("\n");
}

function formatCompletionNotice(name: string, finalization: FinalizationSummary): string {
	const pieces = [`Matt Ralph completed: ${name}`];
	if (finalization.succeeded.length > 0) {
		pieces.push(`commented/closed ${finalization.succeeded.map((result) => `#${result.issue}`).join(", ")}`);
	}
	if (finalization.failed.length > 0) {
		pieces.push(
			`GitHub finalization failed for ${finalization.failed.map((result) => `#${result.issue}`).join(", ")}`,
		);
	}
	if (finalization.skipped.length > 0) pieces.push(finalization.skipped.join(" "));
	return pieces.join("; ");
}

function eventPayload(state: MattRalphState): Record<string, unknown> {
	return {
		name: state.name,
		parentIssue: state.parentIssue,
		targetCount: state.childIssues.length,
		iteration: state.iteration,
		currentIndex: state.currentIndex,
	};
}

function formatTargetLabel(target: ChildIssue): string {
	return target.number > 0 ? `#${target.number} ${target.title}` : target.title;
}

function parseImplementArgs(raw: string): {
	target: string;
	maxIterations?: number;
	exitOnComplete?: boolean;
	sessionSuffix?: string;
	ignoreRalphDirty?: boolean;
	orchestrationChildLink?: MattRalphState["orchestrationChildLink"];
	error?: string;
} {
	const parts = splitArgs(raw);
	let maxIterations: number | undefined;
	let exitOnComplete = false;
	let sessionSuffix: string | undefined;
	let ignoreRalphDirty = false;
	const orchestrationLink: Partial<NonNullable<MattRalphState["orchestrationChildLink"]>> = {};
	const targetParts: string[] = [];
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (part === "--max-iterations") {
			const value = parts[index + 1];
			if (!value || !/^\d+$/.test(value))
				return { target: targetParts.join(" "), error: "--max-iterations requires a positive integer." };
			maxIterations = Number(value);
			if (maxIterations < 1) return { target: targetParts.join(" "), error: "--max-iterations must be at least 1." };
			index += 1;
			continue;
		}
		if (part === "--exit-on-complete") {
			exitOnComplete = true;
			continue;
		}
		if (part === "--session-suffix") {
			const value = parts[index + 1];
			if (!value || value.startsWith("--"))
				return { target: targetParts.join(" "), error: "--session-suffix requires a value." };
			sessionSuffix = sanitizeSessionName(value);
			index += 1;
			continue;
		}
		if (part === "--ignore-ralph-dirty") {
			ignoreRalphDirty = true;
			continue;
		}
		if (part === "--orchestrator-name") {
			const value = parts[index + 1];
			if (!value || value.startsWith("--"))
				return { target: targetParts.join(" "), error: "--orchestrator-name requires a value." };
			orchestrationLink.orchestrationName = sanitizeSessionName(value);
			index += 1;
			continue;
		}
		if (part === "--orchestrator-parent-issue") {
			const value = parsePositiveInteger(parts[index + 1]);
			if (!value) return { target: targetParts.join(" "), error: "--orchestrator-parent-issue requires a number." };
			orchestrationLink.parentIssue = value;
			index += 1;
			continue;
		}
		if (part === "--orchestrator-child-issue") {
			const value = parsePositiveInteger(parts[index + 1]);
			if (!value) return { target: targetParts.join(" "), error: "--orchestrator-child-issue requires a number." };
			orchestrationLink.childIssue = value;
			index += 1;
			continue;
		}
		if (part === "--orchestrator-issue-run-index") {
			const value = parseNonNegativeInteger(parts[index + 1]);
			if (value === undefined)
				return { target: targetParts.join(" "), error: "--orchestrator-issue-run-index requires a number." };
			orchestrationLink.issueRunIndex = value;
			index += 1;
			continue;
		}
		if (part === "--orchestrator-state-path") {
			const value = parts[index + 1];
			if (!value || value.startsWith("--"))
				return { target: targetParts.join(" "), error: "--orchestrator-state-path requires a value." };
			orchestrationLink.parentStatePath = value;
			index += 1;
			continue;
		}
		if (part.startsWith("--")) return { target: targetParts.join(" "), error: `Unknown implement flag: ${part}` };
		targetParts.push(part);
	}
	const orchestrationChildLink = completeOrchestrationChildLink(orchestrationLink);
	if (Object.keys(orchestrationLink).length > 0 && !orchestrationChildLink) {
		return {
			target: targetParts.join(" "),
			error: "Orchestrator flags require name, parent issue, child issue, issue run index, and state path.",
		};
	}
	return {
		target: targetParts.join(" "),
		maxIterations,
		exitOnComplete,
		sessionSuffix,
		ignoreRalphDirty,
		orchestrationChildLink,
	};
}

function completeOrchestrationChildLink(
	link: Partial<NonNullable<MattRalphState["orchestrationChildLink"]>>,
): MattRalphState["orchestrationChildLink"] | undefined {
	if (Object.keys(link).length === 0) return undefined;
	if (
		!link.orchestrationName ||
		link.parentIssue === undefined ||
		link.childIssue === undefined ||
		link.issueRunIndex === undefined ||
		!link.parentStatePath
	) {
		return undefined;
	}
	return {
		orchestrationName: link.orchestrationName,
		parentIssue: link.parentIssue,
		childIssue: link.childIssue,
		issueRunIndex: link.issueRunIndex,
		parentStatePath: link.parentStatePath,
	};
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (!value || !/^\d+$/.test(value)) return undefined;
	const number = Number(value);
	return number > 0 ? number : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
	if (!value || !/^\d+$/.test(value)) return undefined;
	const number = Number(value);
	return number >= 0 ? number : undefined;
}

function ralphOnlyDirtyStatus(status: string): string | undefined {
	const ralphLines = status
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0 && line.slice(3).startsWith(".ralph/"));
	return ralphLines.length > 0 ? ralphLines.join("\n") : undefined;
}

function initialTaskFile(state: MattRalphState): string {
	const targetLines = state.childIssues.map((issue, index) => {
		const label = issue.number > 0 ? `#${issue.number} ${issue.title}` : issue.title;
		return `${index + 1}. ${label} (${issue.source}, ${issue.state ?? "unknown"})`;
	});
	return `# Matt Ralph Session: ${state.name}\n\nStarted: ${state.startedAt}\nMode: ${state.mode}\nRoot input: ${state.rootIssue}\nParent issue: ${state.parentIssue ? `#${state.parentIssue}` : "<none>"}\nMax iterations: ${state.maxIterations ?? "<none>"}\n\n## Targets\n\n${targetLines.join("\n")}\n\n## Preflight\n\n### Initial dirty status\n\n\`\`\`\n${state.initialDirtyStatus || ""}\n\`\`\`\n\n### Ignored .ralph dirty status\n\n\`\`\`\n${state.ignoredDirtyStatus || ""}\n\`\`\`\n\n### Warnings\n\n${(state.warnings ?? []).map((warning) => `- ${warning}`).join("\n") || "- <none>"}\n\n## Progress\n`;
}

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}
