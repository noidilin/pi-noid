import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OrchestratePlan, OrchestrateState } from "./orchestrate-types";

const ACTIVE_ORCHESTRATION = "active-orchestration";

export function ralphDir(cwd: string): string {
	return path.join(cwd, ".ralph");
}

export function orchestrateStatePathFor(cwd: string, name: string): string {
	return path.join(ralphDir(cwd), `${name}.state.json`);
}

export function orchestrateNotePathFor(cwd: string, name: string): string {
	return path.join(ralphDir(cwd), `${name}.md`);
}

export async function createOrchestrateState(
	cwd: string,
	parent: { number: number; title: string; url?: string },
	plan: OrchestratePlan,
	options: { issueTimeoutMs: number },
): Promise<OrchestrateState> {
	const runid = Math.random().toString(36).slice(2, 8);
	const name = `orchestrate-issue-${parent.number}-${runid}`;
	const state: OrchestrateState = {
		name,
		parentIssue: parent.number,
		parentTitle: parent.title,
		parentUrl: parent.url,
		status: plan.valid ? "planned" : "failed",
		startedAt: new Date().toISOString(),
		issueTimeoutMs: options.issueTimeoutMs,
		currentIndex: 0,
		plan,
		issueRuns: plan.plannedOrder.map((issue) => ({ issue: issue.number, title: issue.title, status: "pending" })),
	};
	await mkdir(ralphDir(cwd), { recursive: true });
	await writeFile(orchestrateNotePathFor(cwd, name), initialNote(state), "utf8");
	await writeOrchestrateState(cwd, state);
	return state;
}

export async function writeOrchestrateState(cwd: string, state: OrchestrateState): Promise<void> {
	await mkdir(ralphDir(cwd), { recursive: true });
	await writeFile(orchestrateStatePathFor(cwd, state.name), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function readOrchestrateState(cwd: string, name: string): Promise<OrchestrateState> {
	const normalized = name.replace(/\.state\.json$/, "");
	return JSON.parse(await readFile(orchestrateStatePathFor(cwd, normalized), "utf8")) as OrchestrateState;
}

export async function listOrchestrateStates(cwd: string): Promise<OrchestrateState[]> {
	const dir = ralphDir(cwd);
	if (!existsSync(dir)) return [];
	const states: OrchestrateState[] = [];
	for (const file of await readdir(dir)) {
		if (!file.startsWith("orchestrate-") || !file.endsWith(".state.json")) continue;
		try {
			states.push(JSON.parse(await readFile(path.join(dir, file), "utf8")) as OrchestrateState);
		} catch {}
	}
	return states.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function setActiveOrchestration(cwd: string, name: string | undefined): Promise<void> {
	await mkdir(ralphDir(cwd), { recursive: true });
	await writeFile(path.join(ralphDir(cwd), ACTIVE_ORCHESTRATION), name ? `${name}\n` : "", "utf8");
}

export async function getActiveOrchestration(cwd: string): Promise<string | undefined> {
	const file = path.join(ralphDir(cwd), ACTIVE_ORCHESTRATION);
	if (!existsSync(file)) return undefined;
	const name = (await readFile(file, "utf8")).trim();
	return name || undefined;
}

export async function appendOrchestrateNote(cwd: string, state: OrchestrateState, markdown: string): Promise<void> {
	const file = orchestrateNotePathFor(cwd, state.name);
	const current = existsSync(file) ? await readFile(file, "utf8") : "";
	await writeFile(file, current + markdown, "utf8");
}

export async function requestStop(cwd: string, name: string): Promise<OrchestrateState> {
	const state = await readOrchestrateState(cwd, name);
	state.stopRequested = true;
	state.status = "stopped";
	await writeOrchestrateState(cwd, state);
	return state;
}

function initialNote(state: OrchestrateState): string {
	const plan = state.plan;
	return `# Ralph Orchestration: ${state.name}\n\nStarted: ${state.startedAt}\nParent: #${state.parentIssue} ${state.parentTitle}\nTimeout per issue: ${state.issueTimeoutMs}ms\n\n## Planned order\n\n${plan.plannedOrder.map((issue, index) => `${index + 1}. #${issue.number} ${issue.title}`).join("\n") || "- <none>"}\n\n## Skipped closed children\n\n${plan.skippedClosed.map((issue) => `- #${issue.number} ${issue.title}`).join("\n") || "- <none>"}\n\n## Blockers\n\n${plan.blockers.map((blocker) => `- ${blocker.raw}: ${blocker.reason ?? blocker.status}`).join("\n") || "- <none>"}\n\n## Cycles\n\n${plan.cycles.map((cycle) => `- ${cycle.map((issue) => `#${issue}`).join(" -> ")}`).join("\n") || "- <none>"}\n\n## Progress\n`;
}
