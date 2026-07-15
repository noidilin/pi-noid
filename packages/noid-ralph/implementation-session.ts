import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	dirtyStatus,
	dirtyStatusExcludingRalph,
	discoverChildren,
	finalizeIssue,
	hasCommand,
	isGitRepo,
	viewIssue,
} from "./github";
import { getActiveState, listStates, readState, sanitizeSessionName, setActiveSession, writeState } from "./loop-store";
import {
	finalPromptContext,
	iterationPromptContext,
	renderRalphPrompt,
	systemInjectionContext,
} from "./prompt-template";
import { appendRalphNote, ensureRalphStateStorage, notePathFor } from "./ralph-state-storage";
import {
	finalizeTargetPlan,
	formatTargetFinalizationNotice,
	resolveTargetPlan,
	type TargetCompletion,
	type TargetFinalizationSummary,
	TargetResolutionError,
} from "./tracker-adapter";
import { MATT_RALPH_SCHEMA_VERSION, type MattRalphState, type ResolvedTargetPlan } from "./types";

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
	plan: ResolvedTargetPlan;
	rawDirtyStatus: string;
	initialDirtyStatus?: string;
	ignoredDirtyStatus?: string;
	warnings: string[];
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
	resolveTargetPlan(input: { cwd: string; target: string }): Promise<ResolvedTargetPlan>;
	finalizeTargetPlan(plan: ResolvedTargetPlan, completion: TargetCompletion): Promise<TargetFinalizationSummary>;
};

export function createImplementationSessionAdapters(pi: ExtensionAPI, cwd: string): ImplementationSessionAdapters {
	const now = () => new Date().toISOString();
	const targetExists = (file: string) => existsSync(file);
	const commandAvailable = (command: string) => hasCommand(pi, command, cwd);
	return {
		now,
		targetExists,
		isGitRepo: () => isGitRepo(pi, cwd),
		dirtyStatus: () => dirtyStatus(pi, cwd),
		dirtyStatusExcludingRalph: () => dirtyStatusExcludingRalph(pi, cwd),
		hasCommand: commandAvailable,
		resolveTargetPlan: (input) =>
			resolveTargetPlan(input, {
				targetExists,
				readTarget: (file) => readFile(file, "utf8"),
				viewIssue: (issue) => viewIssue(pi, cwd, issue),
				discoverChildren: (parent) => discoverChildren(pi, cwd, parent),
			}),
		finalizeTargetPlan: (plan, completion) =>
			finalizeTargetPlan(plan, completion, {
				hasCommand: commandAvailable,
				finalizeIssue: (issue, body) => finalizeIssue(pi, cwd, issue, body),
				now,
			}),
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

	let plan: ResolvedTargetPlan;
	try {
		plan = await adapters.resolveTargetPlan({ cwd: input.cwd, target: input.targetArg });
	} catch (error) {
		if (error instanceof TargetResolutionError) {
			return { ok: false, effects: [{ type: "notify", message: error.message, level: "error" }] };
		}
		throw error;
	}

	const rawDirtyStatus = await adapters.dirtyStatus();
	const initialDirtyStatus = input.ignoreRalphDirty ? await adapters.dirtyStatusExcludingRalph() : rawDirtyStatus;
	const ignoredDirtyStatus = input.ignoreRalphDirty ? ralphOnlyDirtyStatus(rawDirtyStatus) : undefined;
	const warnings = await preflightWarnings(input.cwd, plan, adapters);
	const prepared: PreparedImplementationSessionStart = {
		...input,
		plan,
		rawDirtyStatus,
		initialDirtyStatus,
		ignoredDirtyStatus,
		warnings,
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
	const taskFileAbs = notePathFor(prepared.cwd, name);
	const taskFileRel = path.relative(prepared.cwd, taskFileAbs);
	const state: MattRalphState = {
		schemaVersion: MATT_RALPH_SCHEMA_VERSION,
		name,
		taskFile: taskFileRel,
		status: "active",
		mode: "implement",
		rootIssue: prepared.targetArg,
		parentIssue: parentIssueFor(prepared.plan),
		childIssues: prepared.plan.targets.map((target) => ({
			number: target.issueNumber ?? 0,
			title: target.title,
			...(target.state ? { state: target.state } : {}),
			source: target.issueSource ?? "standalone",
		})),
		targetPlan: prepared.plan,
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

	await ensureRalphStateStorage(prepared.cwd);
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
			{
				type: "prompt",
				prompt: renderRalphPrompt("implementation.kickoff", iterationPromptContext(state, "start")),
			},
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
			{
				type: "prompt",
				prompt: renderRalphPrompt("implementation.resume", iterationPromptContext(state, "resume")),
			},
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
	await appendRalphNote(
		input.cwd,
		state.name,
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
		effects.push({
			type: "prompt",
			prompt: renderRalphPrompt("implementation.finalVerification", finalPromptContext(state)),
			deliverAs: "followUp",
		});
		return {
			state,
			message: "All Matt Ralph targets processed. Queued final verification prompt.",
			effects,
		};
	}
	effects.push({
		type: "prompt",
		prompt: renderRalphPrompt("implementation.next", iterationPromptContext(state, "next")),
		deliverAs: "followUp",
	});
	return {
		state,
		message: `Advanced Matt Ralph to target ${state.currentIndex + 1}/${state.childIssues.length}.`,
		effects,
	};
}

export async function completeImplementationSession(input: {
	cwd: string;
	adapters: Pick<ImplementationSessionAdapters, "finalizeTargetPlan" | "now">;
}): Promise<ImplementationSessionResult> {
	const state = await getActiveState(input.cwd);
	if (!state) return { effects: [] };
	const finalization = await input.adapters.finalizeTargetPlan(state.targetPlan, {
		body: "Final verification",
	});
	await appendRalphNote(input.cwd, state.name, finalization.note);
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
			message: formatTargetFinalizationNotice(state.name, finalization),
			level: finalization.failed.length > 0 ? "warning" : "info",
		},
	];
	if (state.exitOnComplete) effects.push({ type: "shutdown" });
	return { state, effects };
}

export function buildImplementationSessionSystemInjection(state: MattRalphState): string {
	return renderRalphPrompt("implementation.systemInjection", systemInjectionContext(state));
}

async function preflightWarnings(
	cwd: string,
	plan: ResolvedTargetPlan,
	adapters: Pick<ImplementationSessionAdapters, "hasCommand" | "targetExists">,
): Promise<string[]> {
	const warnings: string[] = [];
	if (plan.root.source === "github" && !(await adapters.hasCommand("gh"))) {
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

function parentIssueFor(plan: ResolvedTargetPlan): number | undefined {
	if (plan.root.source !== "github") return undefined;
	return plan.root.parentIssueNumber ?? plan.root.issueNumber;
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
