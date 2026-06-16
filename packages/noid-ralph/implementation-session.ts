import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
	ensureStore,
	getActiveState,
	listStates,
	ralphDir,
	readState,
	sanitizeSessionName,
	setActiveSession,
	taskPathFor,
	writeState,
} from "./loop-store";
import {
	buildFinalPrompt,
	buildKickoffPrompt,
	buildNextPrompt,
	buildResumePrompt,
	buildSystemInjection,
} from "./prompt";
import { type ChildIssue, MATT_RALPH_SCHEMA_VERSION, type MattRalphState, type TargetDescriptor } from "./types";

const REQUIRED_SKILLS = ["tdd", "diagnose", "grill-with-docs"];

export type ImplementationStartInput = {
	cwd: string;
	targetArg: string;
	maxIterations?: number;
	exitOnComplete?: boolean;
	sessionSuffix?: string;
	ignoreRalphDirty?: boolean;
	orchestrationChildLink?: MattRalphState["orchestrationChildLink"];
};

export type PreparedImplementationSessionStart = ImplementationStartInput & {
	target: TargetDescriptor;
	rawDirtyStatus: string;
	initialDirtyStatus?: string;
	ignoredDirtyStatus?: string;
	warnings: string[];
	parentIssue?: number;
	children: ChildIssue[];
};

export type ImplementationConfirmation = {
	title: string;
	message: string;
};

export type PrepareImplementationSessionStartResult =
	| { ok: true; prepared: PreparedImplementationSessionStart; confirmation?: ImplementationConfirmation }
	| { ok: false; effects: ImplementationSessionEffect[] };

export type ImplementationSessionResult = {
	effects: ImplementationSessionEffect[];
	state?: MattRalphState;
	message?: string;
};

export type ImplementationSessionEffect =
	| { type: "notify"; message: string; level: "info" | "warning" | "error" }
	| { type: "prompt"; prompt: string; deliverAs?: "followUp" }
	| { type: "event"; name: string; payload: Record<string, unknown> }
	| { type: "updateUi"; state?: MattRalphState }
	| { type: "shutdown" };

export type ImplementationSessionAdapters = {
	now(): string;
	targetExists(file: string): boolean;
	isGitRepo(): Promise<boolean>;
	dirtyStatus(): Promise<string>;
	dirtyStatusExcludingRalph(): Promise<string>;
	hasCommand(command: string): Promise<boolean>;
	viewIssue(issue: number): Promise<Awaited<ReturnType<typeof viewIssue>>>;
	discoverChildren(parent: number): Promise<ChildIssue[]>;
	finalizeIssue(issue: number, body?: string): Promise<FinalizeIssueResult>;
};

export function createImplementationSessionAdapters(pi: ExtensionAPI, cwd: string): ImplementationSessionAdapters {
	return {
		now: () => new Date().toISOString(),
		targetExists: (file) => existsSync(file),
		isGitRepo: () => isGitRepo(pi, cwd),
		dirtyStatus: () => dirtyStatus(pi, cwd),
		dirtyStatusExcludingRalph: () => dirtyStatusExcludingRalph(pi, cwd),
		hasCommand: (command) => hasCommand(pi, command, cwd),
		viewIssue: (issue) => viewIssue(pi, cwd, issue),
		discoverChildren: (parent) => discoverChildren(pi, cwd, parent),
		finalizeIssue: (issue, body) => finalizeIssue(pi, cwd, issue, body),
	};
}

export async function prepareImplementationSessionStart(
	input: ImplementationStartInput,
	adapters: ImplementationSessionAdapters,
): Promise<PrepareImplementationSessionStartResult> {
	if (!input.targetArg) {
		return {
			ok: false,
			effects: [
				{
					type: "notify",
					message:
						"Usage: /ralph implement <issue-or-prd> [--max-iterations N] [--exit-on-complete] [--session-suffix suffix]",
					level: "warning",
				},
			],
		};
	}

	if (!(await adapters.isGitRepo())) {
		return {
			ok: false,
			effects: [{ type: "notify", message: "Matt Ralph requires running inside a git repository.", level: "error" }],
		};
	}

	const target = describeTarget(input.cwd, input.targetArg);
	if (target.kind === "path" && !adapters.targetExists(path.resolve(input.cwd, target.path))) {
		return {
			ok: false,
			effects: [{ type: "notify", message: `Target file not found: ${target.path}`, level: "error" }],
		};
	}

	const rawDirtyStatus = await adapters.dirtyStatus();
	const initialDirtyStatus = input.ignoreRalphDirty ? await adapters.dirtyStatusExcludingRalph() : rawDirtyStatus;
	const ignoredDirtyStatus = input.ignoreRalphDirty ? ralphOnlyDirtyStatus(rawDirtyStatus) : undefined;
	const warnings = await preflightWarnings(input.cwd, target, adapters);
	const { parentIssue, children } = await resolveTargets(target, adapters);
	const prepared: PreparedImplementationSessionStart = {
		...input,
		target,
		rawDirtyStatus,
		initialDirtyStatus,
		ignoredDirtyStatus,
		warnings,
		parentIssue,
		children,
	};
	const confirmation = initialDirtyStatus
		? {
				title: "Dirty worktree",
				message: `git status --porcelain is not clean. Proceed and record the dirty state in .ralph notes?\n\n${initialDirtyStatus}`,
			}
		: undefined;
	return { ok: true, prepared, confirmation };
}

export async function startImplementationSession(
	prepared: PreparedImplementationSessionStart,
): Promise<ImplementationSessionResult> {
	const baseName = `implement-${sanitizeSessionName(prepared.targetArg)}`;
	const name = prepared.sessionSuffix ? `${baseName}-${sanitizeSessionName(prepared.sessionSuffix)}` : baseName;
	const taskFileAbs = taskPathFor(prepared.cwd, name);
	const taskFileRel = path.relative(prepared.cwd, taskFileAbs);
	const state: MattRalphState = {
		schemaVersion: MATT_RALPH_SCHEMA_VERSION,
		name,
		taskFile: taskFileRel,
		status: "active",
		mode: "implement",
		rootIssue: prepared.targetArg,
		parentIssue: prepared.parentIssue,
		childIssues: prepared.children,
		currentIndex: 0,
		iteration: 1,
		startedAt: new Date().toISOString(),
		initialDirtyStatus: prepared.initialDirtyStatus,
		ignoredDirtyStatus: prepared.ignoredDirtyStatus,
		warnings: prepared.warnings,
		maxIterations: prepared.maxIterations,
		exitOnComplete: prepared.exitOnComplete,
		sessionSuffix: prepared.sessionSuffix,
		orchestratorName: prepared.orchestrationChildLink?.orchestrationName,
		orchestrationChildLink: prepared.orchestrationChildLink,
	};

	await ensureStore(prepared.cwd);
	await mkdir(ralphDir(prepared.cwd), { recursive: true });
	await writeFile(taskFileAbs, initialTaskFile(state), "utf8");
	await writeState(prepared.cwd, state);
	await setActiveSession(prepared.cwd, name);

	return {
		state,
		effects: [
			{ type: "updateUi", state },
			{ type: "event", name: "matt_ralph:start", payload: eventPayload(state) },
			...prepared.warnings.map(
				(warning): ImplementationSessionEffect => ({ type: "notify", message: warning, level: "warning" }),
			),
			{ type: "notify", message: `Matt Ralph session created: ${taskFileRel}`, level: "info" },
			{ type: "prompt", prompt: buildKickoffPrompt(state) },
		],
	};
}

export async function resumeImplementationSession(
	cwd: string,
	sessionArg: string,
	adapters: Pick<ImplementationSessionAdapters, "now">,
): Promise<ImplementationSessionResult> {
	const states = await listStates(cwd);
	if (states.length === 0) {
		return { effects: [{ type: "notify", message: "No Matt Ralph sessions found in .ralph/.", level: "warning" }] };
	}
	const name = sessionArg.trim() || states.find((state) => state.status === "paused")?.name || states[0]?.name;
	if (!name) return { effects: [] };
	let state: MattRalphState;
	try {
		state = await readState(cwd, name.replace(/\.state\.json$/, ""));
	} catch {
		return { effects: [{ type: "notify", message: `Matt Ralph session not found: ${name}`, level: "error" }] };
	}
	state.status = "active";
	state.lastResumedAt = adapters.now();
	await writeState(cwd, state);
	await setActiveSession(cwd, state.name);
	return {
		state,
		effects: [
			{ type: "updateUi", state },
			{ type: "prompt", prompt: buildResumePrompt(state) },
		],
	};
}

export async function stopImplementationSession(cwd: string): Promise<ImplementationSessionResult> {
	const state = await getActiveState(cwd);
	if (!state) {
		return { effects: [{ type: "notify", message: "No active Matt Ralph session.", level: "info" }] };
	}
	state.status = "paused";
	await writeState(cwd, state);
	await setActiveSession(cwd, undefined);
	return {
		state,
		effects: [
			{ type: "updateUi", state: undefined },
			{ type: "event", name: "matt_ralph:pause", payload: { name: state.name } },
			{ type: "notify", message: `Paused Matt Ralph session: ${state.name}`, level: "info" },
		],
	};
}

export async function advanceImplementationSession(input: {
	cwd: string;
	hasPendingMessages: boolean;
	adapters: Pick<ImplementationSessionAdapters, "now">;
}): Promise<ImplementationSessionResult> {
	if (input.hasPendingMessages) {
		return { message: "Pending messages already queued. Skipping matt_ralph_done.", effects: [] };
	}
	const state = await getActiveState(input.cwd);
	if (!state) return { message: "No active Matt Ralph session found.", effects: [] };

	state.iteration += 1;
	state.currentIndex += 1;
	state.lastAdvancedAt = input.adapters.now();
	await appendTaskNote(
		input.cwd,
		state,
		`\n\n## Iteration ${state.iteration - 1} advanced\n\nAdvanced at ${state.lastAdvancedAt}.\n`,
	);

	if (state.maxIterations && state.iteration > state.maxIterations) {
		state.status = "paused";
		state.warnings = [...(state.warnings ?? []), `Paused after exceeding maxIterations=${state.maxIterations}.`];
		await writeState(input.cwd, state);
		await setActiveSession(input.cwd, undefined);
		return {
			state,
			message: `Matt Ralph paused after exceeding max iterations (${state.maxIterations}). No more work queued.`,
			effects: [
				{ type: "updateUi", state: undefined },
				{ type: "event", name: "matt_ralph:pause", payload: { name: state.name } },
			],
		};
	}

	await writeState(input.cwd, state);
	const effects: ImplementationSessionEffect[] = [
		{ type: "event", name: "matt_ralph:advance", payload: eventPayload(state) },
		{ type: "updateUi", state },
	];
	if (state.currentIndex >= state.childIssues.length) {
		effects.push({ type: "prompt", prompt: buildFinalPrompt(state), deliverAs: "followUp" });
		return {
			state,
			message: "All Matt Ralph targets processed. Queued final verification prompt.",
			effects,
		};
	}
	effects.push({ type: "prompt", prompt: buildNextPrompt(state), deliverAs: "followUp" });
	return {
		state,
		message: `Advanced Matt Ralph to target ${state.currentIndex + 1}/${state.childIssues.length}.`,
		effects,
	};
}

export async function completeImplementationSession(input: {
	cwd: string;
	adapters: Pick<ImplementationSessionAdapters, "hasCommand" | "finalizeIssue" | "now">;
}): Promise<ImplementationSessionResult> {
	const state = await getActiveState(input.cwd);
	if (!state) return { effects: [] };
	const finalization = await finalizeGithubIssues(input.cwd, state, input.adapters);
	state.status = "completed";
	state.completedAt = input.adapters.now();
	await writeState(input.cwd, state);
	await setActiveSession(input.cwd, undefined);
	const effects: ImplementationSessionEffect[] = [
		{ type: "updateUi", state: undefined },
		{
			type: "event",
			name: "matt_ralph:complete",
			payload: { name: state.name, iteration: state.iteration, finalization },
		},
		{
			type: "notify",
			message: formatCompletionNotice(state.name, finalization),
			level: finalization.failed.length > 0 ? "warning" : "info",
		},
	];
	if (state.exitOnComplete) effects.push({ type: "shutdown" });
	return { state, effects };
}

export function buildImplementationSessionSystemInjection(state: MattRalphState): string {
	return buildSystemInjection(state);
}

function describeTarget(cwd: string, raw: string): TargetDescriptor {
	const issueNumber = parseIssueNumber(raw);
	if (issueNumber) return { kind: "github", raw, number: issueNumber };
	const resolved = path.resolve(cwd, raw);
	if (existsSync(resolved) || raw.includes("/") || raw.endsWith(".md")) return { kind: "path", raw, path: raw };
	return { kind: "text", raw };
}

async function resolveTargets(
	target: TargetDescriptor,
	adapters: Pick<ImplementationSessionAdapters, "viewIssue" | "discoverChildren">,
): Promise<{ parentIssue?: number; children: ChildIssue[] }> {
	if (target.kind !== "github") {
		return { children: [{ number: 0, title: target.raw, source: "standalone" }] };
	}

	const issue = await adapters.viewIssue(target.number);
	const title = issue?.title ?? `Issue #${target.number}`;
	const parentIssue = issue?.parent?.number ?? extractParentFromBody(issue?.body);
	if (parentIssue) {
		return {
			parentIssue,
			children: [{ number: target.number, title, state: issue?.state, source: "standalone" }],
		};
	}

	const children = await adapters.discoverChildren(target.number);
	if (children.length > 0) return { parentIssue: target.number, children };
	return {
		parentIssue: target.number,
		children: [{ number: target.number, title, state: issue?.state, source: "standalone" }],
	};
}

async function preflightWarnings(
	cwd: string,
	target: TargetDescriptor,
	adapters: Pick<ImplementationSessionAdapters, "hasCommand" | "targetExists">,
): Promise<string[]> {
	const warnings: string[] = [];
	if (target.kind === "github" && !(await adapters.hasCommand("gh"))) {
		warnings.push(
			"GitHub issue target detected, but gh is not available. Install/auth gh before agent issue fetches.",
		);
	}
	for (const skill of REQUIRED_SKILLS) {
		if (!adapters.targetExists(`/Users/noid/.agents/skills/${skill}`))
			warnings.push(`Matt skill not found: ${skill}. Configure/install Matt skills if the agent needs it.`);
	}
	const hasAgentDocs = ["AGENTS.md", "CLAUDE.md", "docs/agents"].some((entry) =>
		adapters.targetExists(path.join(cwd, entry)),
	);
	if (!hasAgentDocs)
		warnings.push(
			"No AGENTS.md, CLAUDE.md, or docs/agents/ found. Consider running the Matt setup skill; extension will not mutate settings.",
		);
	return warnings;
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

type FinalizationSummary = {
	succeeded: FinalizeIssueResult[];
	failed: FinalizeIssueResult[];
	skipped: string[];
};

async function finalizeGithubIssues(
	cwd: string,
	state: MattRalphState,
	adapters: Pick<ImplementationSessionAdapters, "hasCommand" | "finalizeIssue">,
): Promise<FinalizationSummary> {
	const issueNumbers = githubIssueNumbersFor(state);
	if (issueNumbers.length === 0) {
		const skipped = ["No GitHub issue targets in this session."];
		await appendTaskNote(cwd, state, finalizationNote([], [], skipped));
		return { succeeded: [], failed: [], skipped };
	}
	if (!(await adapters.hasCommand("gh"))) {
		const skipped = ["gh is not available; skipped final GitHub issue comment/close."];
		await appendTaskNote(cwd, state, finalizationNote([], [], skipped));
		return { succeeded: [], failed: [], skipped };
	}

	const results: FinalizeIssueResult[] = [];
	for (const issue of issueNumbers) results.push(await adapters.finalizeIssue(issue));
	const succeeded = results.filter((result) => result.commented && result.closed);
	const failed = results.filter((result) => !result.commented || !result.closed);
	await appendTaskNote(cwd, state, finalizationNote(succeeded, failed, []));
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
