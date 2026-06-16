import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isIssueClosed } from "./github";
import { readPane, runInPane, waitOutput } from "./herdr-runner";
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
	runInPane(paneId: string, command: string): Promise<void>;
	waitOutput(paneId: string, match: string, timeoutMs: number): Promise<boolean>;
	readPane(paneId: string, lines: number): Promise<string>;
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
		runInPane: (paneId, command) => runInPane(pi, cwd, paneId, command),
		waitOutput: (paneId, match, timeoutMs) => waitOutput(pi, cwd, paneId, match, timeoutMs),
		readPane: (paneId, lines) => readPane(pi, cwd, paneId, lines),
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

		const sentinel = `${input.orchestrationName}-${input.issue}-${Date.now()}`;
		const workerPrompt = `/ralph implement #${input.issue} --exit-on-complete --ignore-ralph-dirty --session-suffix ${suffix}`;
		const workerScript = path.join(ralphDir(input.cwd), `${input.orchestrationName}-issue-${input.issue}.worker.sh`);
		facts.workerScript = path.relative(input.cwd, workerScript);
		await adapters.writeWorkerScript(workerScript, workerScriptContent(input.issue, workerPrompt, sentinel));
		await emit({ type: "workerScriptWritten", facts: { workerScript: facts.workerScript } });

		facts.workerLaunchedAt = adapters.now();
		await adapters.runInPane(input.paneId, `sh ${shellQuote(workerScript)}`);
		await emit({ type: "workerLaunched", facts: { workerLaunchedAt: facts.workerLaunchedAt } });

		const exited = await adapters.waitOutput(input.paneId, `sentinel=${sentinel}`, input.issueTimeoutMs);
		facts.workerExitedAt = adapters.now();
		diagnostics.paneTail = await adapters.readPane(input.paneId, 80);
		facts.workerExitCode = parseWorkerExitCode(diagnostics.paneTail, sentinel) ?? undefined;
		await emit({
			type: "workerExited",
			facts: { workerExitedAt: facts.workerExitedAt, workerExitCode: facts.workerExitCode },
		});
		if (!exited) return fail("Worker timed out before sentinel.");

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
		if (!diagnostics.paneTail) diagnostics.paneTail = await safeReadPane(adapters, input.paneId);
		return fail(error instanceof Error ? error.message : String(error));
	}
}

export function parseWorkerExitCode(paneTail: string, sentinel: string): number | undefined {
	const escapedSentinel = sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = paneTail.match(
		new RegExp(`RALPH_WORKER_EXIT\\s+issue=\\d+\\s+code=(\\d+)\\s+sentinel=${escapedSentinel}`),
	);
	return match ? Number(match[1]) : undefined;
}

async function safeReadPane(adapters: ChildRunAdapters, paneId: string): Promise<string | undefined> {
	try {
		return await adapters.readPane(paneId, 80);
	} catch {
		return undefined;
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

function workerScriptContent(issue: number, workerPrompt: string, sentinel: string): string {
	return `#!/bin/sh
printf '\n[ralph-orchestrator] starting issue #${issue}\n'
pi --name ${shellQuote(`ralph #${issue}`)} ${shellQuote(workerPrompt)}
code=$?
printf '\nRALPH_WORKER_EXIT issue=${issue} code=%s sentinel=${sentinel}\n' "$code"
exit "$code"
`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
