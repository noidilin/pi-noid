import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	advanceImplementationSession,
	buildImplementationSessionSystemInjection,
	completeImplementationSession,
	createImplementationSessionAdapters,
	type ImplementationSessionEffect,
	prepareImplementationSessionStart,
	resumeImplementationSession,
	startImplementationSession,
	stopImplementationSession,
} from "./implementation-session";
import {
	archiveState,
	deleteState,
	deleteTask,
	getActiveState,
	listArchivedStates,
	listStates,
	readState,
	sanitizeSessionName,
} from "./loop-store";
import { orchestrate } from "./orchestrate";
import type { ChildIssue, MattRalphState } from "./types";

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
			const result = await advanceImplementationSession({
				cwd: ctx.cwd,
				hasPendingMessages: ctx.hasPendingMessages(),
				adapters: createImplementationSessionAdapters(pi, ctx.cwd),
			});
			await executeImplementationSessionEffects(pi, ctx, result.effects);
			return {
				content: [{ type: "text", text: result.message ?? "Matt Ralph advanced." }],
				details: result.state ? { state: result.state } : {},
			};
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = await getActiveState(ctx.cwd);
		if (!state) return;
		return { systemPrompt: event.systemPrompt + buildImplementationSessionSystemInjection(state) };
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const text = JSON.stringify(event.message);
		if (!text.includes("MATT_RALPH_COMPLETE")) return;
		const result = await completeImplementationSession({
			cwd: ctx.cwd,
			adapters: createImplementationSessionAdapters(pi, ctx.cwd),
		});
		await executeImplementationSessionEffects(pi, ctx, result.effects);
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
	const adapters = createImplementationSessionAdapters(pi, ctx.cwd);
	const prepared = await prepareImplementationSessionStart(
		{
			cwd: ctx.cwd,
			targetArg: parsed.target,
			maxIterations: parsed.maxIterations,
			exitOnComplete: parsed.exitOnComplete,
			sessionSuffix: parsed.sessionSuffix,
			ignoreRalphDirty: parsed.ignoreRalphDirty,
			orchestrationChildLink: parsed.orchestrationChildLink,
		},
		adapters,
	);
	if (!prepared.ok) {
		await executeImplementationSessionEffects(pi, ctx, prepared.effects);
		return;
	}
	if (prepared.confirmation && ctx.hasUI) {
		const proceed = await ctx.ui.confirm(prepared.confirmation.title, prepared.confirmation.message);
		if (!proceed) return;
	}
	const result = await startImplementationSession(prepared.prepared);
	await executeImplementationSessionEffects(pi, ctx, result.effects);
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
	const result = await resumeImplementationSession(
		ctx.cwd,
		sessionArg,
		createImplementationSessionAdapters(pi, ctx.cwd),
	);
	await executeImplementationSessionEffects(pi, ctx, result.effects);
}

async function stop(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const result = await stopImplementationSession(ctx.cwd);
	await executeImplementationSessionEffects(pi, ctx, result.effects);
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

async function executeImplementationSessionEffects(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	effects: ImplementationSessionEffect[],
): Promise<void> {
	for (const effect of effects) {
		if (effect.type === "notify") ctx.ui.notify(effect.message, effect.level);
		else if (effect.type === "prompt") {
			pi.sendUserMessage(effect.prompt, effect.deliverAs ? { deliverAs: effect.deliverAs } : undefined);
		} else if (effect.type === "event") emitMattEvent(pi, effect.name, effect.payload);
		else if (effect.type === "updateUi") updateMattRalphUI(ctx, effect.state);
		else if (effect.type === "shutdown") (ctx as { shutdown?: () => void }).shutdown?.();
	}
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

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}
