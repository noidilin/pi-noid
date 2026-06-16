import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isIssueClosed } from "./github";
import {
	createChildRalphWorkerScript,
	type HerdrWorkerRunResult,
	type HerdrWorkerRunSpec,
	runWorkerScriptInPane,
} from "./herdr-runner";
import { listStates, ralphDir, sanitizeSessionName } from "./loop-store";
import type { OrchestrateIssueRun } from "./orchestrate-types";
import type { MattRalphState, OrchestrationChildLink } from "./types";

export type ChildRunInput = {
	cwd: string;
	orchestrationName: string;
	index: number;
	run: OrchestrateIssueRun;
	parentIssue: number;
	parentStatePath: string;
	paneId: string;
	issueTimeoutMs: number;
};

export type ClosedChildRunInput = Omit<ChildRunInput, "paneId" | "issueTimeoutMs">;

export type ChildRunFacts = {
	startedAt: string;
	completedAt: string;
	sessionName: string;
	workerScript: string;
	workerLaunchedAt: string;
	workerExitedAt: string;
	workerExitCode?: number;
	ralphStartedAt?: string;
	ralphCompletedAt?: string;
	initialDirtyStatus?: string;
	ignoredDirtyStatus?: string;
	headBefore: string;
	headAfter: string;
	commits: string[];
};

export type ChildRunProgress =
	| { type: "started"; facts: Pick<ChildRunFacts, "startedAt" | "headBefore" | "sessionName"> }
	| { type: "workerScriptWritten"; facts: Pick<ChildRunFacts, "workerScript"> }
	| { type: "workerLaunched"; facts: Pick<ChildRunFacts, "workerLaunchedAt"> }
	| {
			type: "workerExited";
			facts: Pick<ChildRunFacts, "workerExitedAt"> & Partial<Pick<ChildRunFacts, "workerExitCode">>;
	  }
	| {
			type: "childStateRead";
			facts: Partial<
				Pick<ChildRunFacts, "ralphStartedAt" | "ralphCompletedAt" | "initialDirtyStatus" | "ignoredDirtyStatus">
			> & { childStatus?: MattRalphState["status"] };
	  }
	| { type: "resumeVerified"; facts: Pick<ChildRunFacts, "completedAt"> }
	| { type: "completed"; facts: Pick<ChildRunFacts, "completedAt" | "headAfter" | "commits"> }
	| { type: "failed"; reason: string; facts: Partial<ChildRunFacts>; diagnostics: ChildRunDiagnostics };

export type ChildRunDiagnostics = {
	paneTail?: string;
	childStatus?: MattRalphState["status"];
	childLink?: OrchestrationChildLink;
};

export type ChildRunOutcome =
	| { ok: true; facts: ChildRunFacts }
	| { ok: false; reason: string; facts: Partial<ChildRunFacts>; diagnostics: ChildRunDiagnostics };

export type ClosedChildRunOutcome = { ok: true } | { ok: false; reason: string; diagnostics: ChildRunDiagnostics };

export type ChildRunAdapters = {
	now(): string;
	git(args: string[]): Promise<string>;
	writeWorkerScript(file: string, content: string): Promise<void>;
	runWorkerScript(spec: HerdrWorkerRunSpec): Promise<HerdrWorkerRunResult>;
	findRalphSession(sessionName: string): Promise<MattRalphState | undefined>;
	isIssueClosed(issue: number): Promise<boolean>;
};

export function createChildRunAdapters(pi: ExtensionAPI, cwd: string): ChildRunAdapters {
	return {
		now: () => new Date().toISOString(),
		git: (args) => git(pi, cwd, args),
		writeWorkerScript: async (file, content) => {
			await writeFile(file, content, "utf8");
			await chmod(file, 0o755);
		},
		runWorkerScript: (spec) => runWorkerScriptInPane(pi, cwd, spec),
		findRalphSession: (sessionName) => findRalphSession(cwd, sessionName),
		isIssueClosed: (issue) => isIssueClosed(pi, cwd, issue),
	};
}

export async function runChildIssue(
	input: ChildRunInput,
	adapters: ChildRunAdapters,
	onStateChanged?: (progress: ChildRunProgress) => Promise<void> | void,
): Promise<ChildRunOutcome> {
	const facts: Partial<ChildRunFacts> = {};
	const diagnostics: ChildRunDiagnostics = {};
	const apply = async (progress: ChildRunProgress) => {
		applyChildRunProgress(input.run, progress);
		await onStateChanged?.(progress);
	};
	const fail = async (reason: string, extraDiagnostics: ChildRunDiagnostics = {}): Promise<ChildRunOutcome> => {
		Object.assign(diagnostics, extraDiagnostics);
		await apply({ type: "failed", reason, facts, diagnostics });
		return { ok: false, reason, facts, diagnostics };
	};

	try {
		const issue = input.run.issue;
		facts.startedAt = adapters.now();
		facts.headBefore = await adapters.git(["rev-parse", "HEAD"]);
		const suffix = sanitizeSessionName(`${input.orchestrationName}-${input.index + 1}-issue-${issue}`);
		facts.sessionName = `implement-${sanitizeSessionName(`#${issue}`)}-${suffix}`;
		await apply({
			type: "started",
			facts: { startedAt: facts.startedAt, headBefore: facts.headBefore, sessionName: facts.sessionName },
		});

		const workerPrompt = `/ralph implement #${issue} --exit-on-complete --ignore-ralph-dirty --session-suffix ${suffix} --orchestrator-name ${input.orchestrationName} --orchestrator-parent-issue ${input.parentIssue} --orchestrator-child-issue ${issue} --orchestrator-issue-run-index ${input.index} --orchestrator-state-path ${input.parentStatePath}`;
		const worker = createChildRalphWorkerScript({ issue, prompt: workerPrompt });
		const workerScript = path.join(ralphDir(input.cwd), `${input.orchestrationName}-issue-${issue}.worker.sh`);
		facts.workerScript = path.relative(input.cwd, workerScript);
		await adapters.writeWorkerScript(workerScript, worker.content);
		await apply({ type: "workerScriptWritten", facts: { workerScript: facts.workerScript } });

		const workerRun = await adapters.runWorkerScript({
			paneId: input.paneId,
			scriptPath: workerScript,
			sentinel: worker.sentinel,
			timeoutMs: input.issueTimeoutMs,
			onLaunched: async () => {
				facts.workerLaunchedAt = adapters.now();
				await apply({ type: "workerLaunched", facts: { workerLaunchedAt: facts.workerLaunchedAt } });
			},
		});
		facts.workerExitedAt = adapters.now();
		diagnostics.paneTail = workerRun.tail;
		facts.workerExitCode = workerRun.exitCode;
		await apply({
			type: "workerExited",
			facts: { workerExitedAt: facts.workerExitedAt, workerExitCode: facts.workerExitCode },
		});
		if (!workerRun.exited) return fail("Worker timed out before sentinel.");

		const childState = await adapters.findRalphSession(facts.sessionName);
		applyChildStateFacts(facts, diagnostics, childState);
		await apply({
			type: "childStateRead",
			facts: {
				ralphStartedAt: facts.ralphStartedAt,
				ralphCompletedAt: facts.ralphCompletedAt,
				initialDirtyStatus: facts.initialDirtyStatus,
				ignoredDirtyStatus: facts.ignoredDirtyStatus,
				childStatus: childState?.status,
			},
		});
		if (childState?.status !== "completed") return fail("Child Ralph session did not complete.");
		if (!childLinkMatches(childState.orchestrationChildLink, input)) {
			return fail("Child Ralph session link is missing or mismatched.");
		}

		if (!(await adapters.isIssueClosed(issue))) return fail("GitHub child issue is still open.");

		facts.headAfter = await adapters.git(["rev-parse", "HEAD"]);
		facts.commits = (await adapters.git(["log", "--oneline", `${facts.headBefore}..${facts.headAfter}`]))
			.split("\n")
			.filter(Boolean);
		if (facts.commits.length === 0) return fail("No commits were produced for child issue.");

		facts.completedAt = adapters.now();
		await apply({
			type: "completed",
			facts: { completedAt: facts.completedAt, headAfter: facts.headAfter, commits: facts.commits },
		});
		return { ok: true, facts: facts as ChildRunFacts };
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

export async function verifyClosedChildRun(
	input: ClosedChildRunInput,
	adapters: ChildRunAdapters,
	onStateChanged?: (progress: ChildRunProgress) => Promise<void> | void,
): Promise<ClosedChildRunOutcome> {
	const diagnostics: ChildRunDiagnostics = {};
	const facts: Partial<ChildRunFacts> = {};
	const apply = async (progress: ChildRunProgress) => {
		applyChildRunProgress(input.run, progress);
		await onStateChanged?.(progress);
	};
	const fail = async (reason: string): Promise<ClosedChildRunOutcome> => {
		await apply({ type: "failed", reason, facts, diagnostics });
		return { ok: false, reason, diagnostics };
	};

	const childState = input.run.sessionName ? await adapters.findRalphSession(input.run.sessionName) : undefined;
	applyChildStateFacts(facts, diagnostics, childState);
	await apply({
		type: "childStateRead",
		facts: {
			ralphStartedAt: facts.ralphStartedAt,
			ralphCompletedAt: facts.ralphCompletedAt,
			initialDirtyStatus: facts.initialDirtyStatus,
			ignoredDirtyStatus: facts.ignoredDirtyStatus,
			childStatus: childState?.status,
		},
	});
	if (childState?.status !== "completed" || !childLinkMatches(childState.orchestrationChildLink, input)) {
		return fail(`Resume found closed child #${input.run.issue} without its expected orchestration child link.`);
	}
	facts.completedAt = adapters.now();
	await apply({ type: "resumeVerified", facts: { completedAt: facts.completedAt } });
	return { ok: true };
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
	if (progress.type === "resumeVerified") {
		run.status = "completed";
		run.completedAt = progress.facts.completedAt;
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

function applyChildStateFacts(
	facts: Partial<ChildRunFacts>,
	diagnostics: ChildRunDiagnostics,
	childState: MattRalphState | undefined,
): void {
	diagnostics.childStatus = childState?.status;
	diagnostics.childLink = childState?.orchestrationChildLink;
	facts.ralphStartedAt = childState?.startedAt;
	facts.ralphCompletedAt = childState?.completedAt;
	facts.initialDirtyStatus = childState?.initialDirtyStatus;
	facts.ignoredDirtyStatus = childState?.ignoredDirtyStatus;
}

function childLinkMatches(link: OrchestrationChildLink | undefined, input: ClosedChildRunInput): boolean {
	return Boolean(
		link &&
			link.orchestrationName === input.orchestrationName &&
			link.parentIssue === input.parentIssue &&
			link.childIssue === input.run.issue &&
			link.issueRunIndex === input.index &&
			link.parentStatePath === input.parentStatePath,
	);
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
	const result = await pi.exec("git", args, { cwd, timeout: 10_000 });
	if (result.code !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

async function findRalphSession(cwd: string, sessionName: string): Promise<MattRalphState | undefined> {
	const states = await listStates(cwd);
	return states.find((state) => state.name === sessionName);
}
