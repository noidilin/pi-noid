import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ralphDir } from "./ralph-state-storage";

export type HerdrPane = { paneId: string; tabId?: string; workspaceId?: string };

type HerdrWorkerScript = {
	content: string;
	sentinel: string;
};

type HerdrWorkerRunSpec = {
	paneId: string;
	scriptPath: string;
	sentinel: string;
	timeoutMs: number;
	tailLines?: number;
	onLaunched?: () => Promise<void> | void;
};

type HerdrWorkerRunResult = {
	exited: boolean;
	exitCode?: number;
	tail: string;
};

export type ChildRalphSessionWorkerSpec = {
	cwd: string;
	paneId: string;
	orchestrationName: string;
	issue: number;
	prompt: string;
	timeoutMs: number;
	tailLines?: number;
	now?: () => string;
};

export type ChildRalphSessionWorkerEvidence = {
	workerScript: string;
	workerLaunchedAt: string;
	workerExitedAt: string;
	workerExitCode?: number;
	paneTail: string;
	exited: boolean;
	sentinel: string;
};

export type ChildRalphSessionWorkerEvent =
	| { type: "workerScriptWritten"; facts: Pick<ChildRalphSessionWorkerEvidence, "workerScript" | "sentinel"> }
	| { type: "workerLaunched"; facts: Pick<ChildRalphSessionWorkerEvidence, "workerLaunchedAt"> }
	| {
			type: "workerExited";
			facts: Pick<ChildRalphSessionWorkerEvidence, "workerExitedAt"> &
				Partial<Pick<ChildRalphSessionWorkerEvidence, "workerExitCode">>;
	  };

export function assertInsideHerdr(): void {
	if (process.env.HERDR_ENV !== "1") throw new Error("/ralph orchestrate requires HERDR_ENV=1");
}

function createChildRalphWorkerScript(input: { issue: number; prompt: string; sentinel?: string }): HerdrWorkerScript {
	const sentinel = input.sentinel ?? `issue-${input.issue}-${Date.now()}`;
	return {
		sentinel,
		content: `#!/bin/sh
printf '\n[ralph-orchestrator] starting issue #${input.issue}\n'
pi --name ${shellQuote(`ralph #${input.issue}`)} ${shellQuote(input.prompt)}
code=$?
printf '\nRALPH_WORKER_EXIT issue=${input.issue} code=%s sentinel=${sentinel}\n' "$code"
exit "$code"
`,
	};
}

export async function getFocusedPane(pi: ExtensionAPI, cwd: string): Promise<HerdrPane> {
	const result = await pi.exec("herdr", ["pane", "list"], { cwd, timeout: 10_000 });
	if (result.code !== 0) throw new Error(result.stderr || "herdr pane list failed");
	const parsed = JSON.parse(result.stdout) as unknown;
	const panes = extractArray(parsed);
	const focused =
		panes.find((pane) => Boolean(readField(pane, "focused") ?? readField(pane, "is_focused"))) ?? panes[0];
	const paneId = stringField(focused, "pane_id") ?? stringField(focused, "id");
	if (!paneId) throw new Error("Could not determine focused herdr pane.");
	const workspaceId = stringField(focused, "workspace_id") ?? paneId.split("-")[0];
	return { paneId, tabId: stringField(focused, "tab_id"), workspaceId };
}

export async function createWorkerPane(
	pi: ExtensionAPI,
	cwd: string,
	sourcePaneId: string,
	direction: "right" | "down" = "right",
): Promise<HerdrPane> {
	const result = await pi.exec("herdr", ["pane", "split", sourcePaneId, "--direction", direction, "--no-focus"], {
		cwd,
		timeout: 10_000,
	});
	if (result.code !== 0) throw new Error(result.stderr || "herdr pane split failed");
	const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
	const root = readField(parsed, "result") as Record<string, unknown> | undefined;
	const pane = readField(root, "pane") as Record<string, unknown> | undefined;
	const paneId = stringField(pane, "pane_id") ?? stringField(pane, "id");
	if (!paneId) throw new Error("Could not parse herdr pane split response.");
	return {
		paneId,
		tabId: stringField(pane, "tab_id"),
		workspaceId: stringField(pane, "workspace_id") ?? paneId.split("-")[0],
	};
}

export async function runChildRalphSessionWorker(
	pi: ExtensionAPI,
	spec: ChildRalphSessionWorkerSpec,
	onEvent?: (event: ChildRalphSessionWorkerEvent) => Promise<void> | void,
): Promise<ChildRalphSessionWorkerEvidence> {
	const now = spec.now ?? (() => new Date().toISOString());
	const worker = createChildRalphWorkerScript({ issue: spec.issue, prompt: spec.prompt });
	const scriptPath = path.join(ralphDir(spec.cwd), `${spec.orchestrationName}-issue-${spec.issue}.worker.sh`);
	await mkdir(path.dirname(scriptPath), { recursive: true });
	await writeFile(scriptPath, worker.content, "utf8");
	await chmod(scriptPath, 0o755);
	const workerScript = path.relative(spec.cwd, scriptPath);
	await onEvent?.({ type: "workerScriptWritten", facts: { workerScript, sentinel: worker.sentinel } });

	let workerLaunchedAt = "";
	const run = await runWorkerScriptInPane(pi, spec.cwd, {
		paneId: spec.paneId,
		scriptPath,
		sentinel: worker.sentinel,
		timeoutMs: spec.timeoutMs,
		tailLines: spec.tailLines,
		onLaunched: async () => {
			workerLaunchedAt = now();
			await onEvent?.({ type: "workerLaunched", facts: { workerLaunchedAt } });
		},
	});
	const workerExitedAt = now();
	const workerExitCode = run.exitCode;
	await onEvent?.({ type: "workerExited", facts: { workerExitedAt, workerExitCode } });
	return {
		workerScript,
		workerLaunchedAt,
		workerExitedAt,
		workerExitCode,
		paneTail: run.tail,
		exited: run.exited,
		sentinel: worker.sentinel,
	};
}

async function runWorkerScriptInPane(
	pi: ExtensionAPI,
	cwd: string,
	spec: HerdrWorkerRunSpec,
): Promise<HerdrWorkerRunResult> {
	await runInPane(pi, cwd, spec.paneId, `sh ${shellQuote(spec.scriptPath)}`);
	await spec.onLaunched?.();
	const exited = await waitOutput(pi, cwd, spec.paneId, `sentinel=${spec.sentinel}`, spec.timeoutMs);
	const tail = await readPane(pi, cwd, spec.paneId, spec.tailLines ?? 80);
	return { exited, exitCode: parseWorkerExitCode(tail, spec.sentinel), tail };
}

async function runInPane(pi: ExtensionAPI, cwd: string, paneId: string, command: string): Promise<void> {
	const result = await pi.exec("herdr", ["pane", "run", paneId, command], { cwd, timeout: 10_000 });
	if (result.code !== 0) throw new Error(result.stderr || "herdr pane run failed");
}

export async function waitAgentStatus(
	pi: ExtensionAPI,
	cwd: string,
	paneId: string,
	status: string,
	timeoutMs: number,
): Promise<boolean> {
	const result = await pi.exec(
		"herdr",
		["wait", "agent-status", paneId, "--status", status, "--timeout", String(timeoutMs)],
		{
			cwd,
			timeout: timeoutMs + 5_000,
		},
	);
	return result.code === 0;
}

async function waitOutput(
	pi: ExtensionAPI,
	cwd: string,
	paneId: string,
	match: string,
	timeoutMs: number,
): Promise<boolean> {
	const result = await pi.exec("herdr", ["wait", "output", paneId, "--match", match, "--timeout", String(timeoutMs)], {
		cwd,
		timeout: timeoutMs + 5_000,
	});
	return result.code === 0;
}

async function readPane(pi: ExtensionAPI, cwd: string, paneId: string, lines = 80): Promise<string> {
	const result = await pi.exec(
		"herdr",
		["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)],
		{
			cwd,
			timeout: 10_000,
		},
	);
	return result.stdout || result.stderr;
}

export async function sendKeys(pi: ExtensionAPI, cwd: string, paneId: string, keys: string): Promise<void> {
	await pi.exec("herdr", ["pane", "send-keys", paneId, keys], { cwd, timeout: 10_000 });
}

function parseWorkerExitCode(paneTail: string, sentinel: string): number | undefined {
	const escapedSentinel = sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = paneTail.match(
		new RegExp(`RALPH_WORKER_EXIT\\s+issue=\\d+\\s+code=(\\d+)\\s+sentinel=${escapedSentinel}`),
	);
	return match ? Number(match[1]) : undefined;
}

function extractArray(value: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
	const result = readField(value as Record<string, unknown>, "result");
	if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
	const panes = readField(result as Record<string, unknown>, "panes");
	return Array.isArray(panes) ? (panes as Array<Record<string, unknown>>) : [];
}

function readField(value: Record<string, unknown> | undefined, key: string): unknown {
	return value?.[key];
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const field = value?.[key];
	return typeof field === "string" ? field : undefined;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
