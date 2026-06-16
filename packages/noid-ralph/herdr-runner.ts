import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type HerdrPane = { paneId: string; tabId?: string; workspaceId?: string };

export type HerdrWorkerScript = {
	content: string;
	sentinel: string;
};

export type HerdrWorkerRunSpec = {
	paneId: string;
	scriptPath: string;
	sentinel: string;
	timeoutMs: number;
	tailLines?: number;
	onLaunched?: () => Promise<void> | void;
};

export type HerdrWorkerRunResult = {
	exited: boolean;
	exitCode?: number;
	tail: string;
};

export function assertInsideHerdr(): void {
	if (process.env.HERDR_ENV !== "1") throw new Error("/ralph orchestrate requires HERDR_ENV=1");
}

export function createChildRalphWorkerScript(input: {
	issue: number;
	prompt: string;
	sentinel?: string;
}): HerdrWorkerScript {
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

export async function runWorkerScriptInPane(
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

export function parseWorkerExitCode(paneTail: string, sentinel: string): number | undefined {
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
