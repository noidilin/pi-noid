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
import type { MattRalphState } from "./types";

export type ChildRunInput = {
	cwd: string;
	orchestrationName: string;
	index: number;
	issue: number;
	title: string;
	paneId: string;
	issueTimeoutMs: number;
};

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
	| { type: "completed"; facts: Pick<ChildRunFacts, "completedAt" | "headAfter" | "commits"> }
	| { type: "failed"; reason: string; facts: Partial<ChildRunFacts>; diagnostics: ChildRunDiagnostics };

export type ChildRunDiagnostics = {
	paneTail?: string;
	childStatus?: MattRalphState["status"];
};

export type ChildRunOutcome =
	| { ok: true; facts: ChildRunFacts }
	| { ok: false; reason: string; facts: Partial<ChildRunFacts>; diagnostics: ChildRunDiagnostics };

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
	onProgress?: (progress: ChildRunProgress) => Promise<void> | void,
): Promise<ChildRunOutcome> {
	const facts: Partial<ChildRunFacts> = {};
	const diagnostics: ChildRunDiagnostics = {};
	const emit = async (progress: ChildRunProgress) => onProgress?.(progress);
	const fail = async (reason: string, extraDiagnostics: ChildRunDiagnostics = {}): Promise<ChildRunOutcome> => {
		Object.assign(diagnostics, extraDiagnostics);
		await emit({ type: "failed", reason, facts, diagnostics });
		return { ok: false, reason, facts, diagnostics };
	};

	try {
		facts.startedAt = adapters.now();
		facts.headBefore = await adapters.git(["rev-parse", "HEAD"]);
		const suffix = sanitizeSessionName(`${input.orchestrationName}-${input.index + 1}-issue-${input.issue}`);
		facts.sessionName = `implement-${sanitizeSessionName(`#${input.issue}`)}-${suffix}`;
		await emit({
			type: "started",
			facts: { startedAt: facts.startedAt, headBefore: facts.headBefore, sessionName: facts.sessionName },
		});

		const workerPrompt = `/ralph implement #${input.issue} --exit-on-complete --ignore-ralph-dirty --session-suffix ${suffix}`;
		const worker = createChildRalphWorkerScript({ issue: input.issue, prompt: workerPrompt });
		const workerScript = path.join(ralphDir(input.cwd), `${input.orchestrationName}-issue-${input.issue}.worker.sh`);
		facts.workerScript = path.relative(input.cwd, workerScript);
		await adapters.writeWorkerScript(workerScript, worker.content);
		await emit({ type: "workerScriptWritten", facts: { workerScript: facts.workerScript } });

		const workerRun = await adapters.runWorkerScript({
			paneId: input.paneId,
			scriptPath: workerScript,
			sentinel: worker.sentinel,
			timeoutMs: input.issueTimeoutMs,
			onLaunched: async () => {
				facts.workerLaunchedAt = adapters.now();
				await emit({ type: "workerLaunched", facts: { workerLaunchedAt: facts.workerLaunchedAt } });
			},
		});
		facts.workerExitedAt = adapters.now();
		diagnostics.paneTail = workerRun.tail;
		facts.workerExitCode = workerRun.exitCode;
		await emit({
			type: "workerExited",
			facts: { workerExitedAt: facts.workerExitedAt, workerExitCode: facts.workerExitCode },
		});
		if (!workerRun.exited) return fail("Worker timed out before sentinel.");

		const childState = await adapters.findRalphSession(facts.sessionName);
		diagnostics.childStatus = childState?.status;
		facts.ralphStartedAt = childState?.startedAt;
		facts.ralphCompletedAt = childState?.completedAt;
		facts.initialDirtyStatus = childState?.initialDirtyStatus;
		facts.ignoredDirtyStatus = childState?.ignoredDirtyStatus;
		await emit({
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

		if (!(await adapters.isIssueClosed(input.issue))) return fail("GitHub child issue is still open.");

		facts.headAfter = await adapters.git(["rev-parse", "HEAD"]);
		facts.commits = (await adapters.git(["log", "--oneline", `${facts.headBefore}..${facts.headAfter}`]))
			.split("\n")
			.filter(Boolean);
		if (facts.commits.length === 0) return fail("No commits were produced for child issue.");

		facts.completedAt = adapters.now();
		await emit({
			type: "completed",
			facts: { completedAt: facts.completedAt, headAfter: facts.headAfter, commits: facts.commits },
		});
		return { ok: true, facts: facts as ChildRunFacts };
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
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
