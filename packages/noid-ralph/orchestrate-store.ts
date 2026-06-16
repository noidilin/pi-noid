import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatInitialOrchestrateNote } from "./orchestrate-projection";
import { ORCHESTRATE_SCHEMA_VERSION, type OrchestratePlan, type OrchestrateState } from "./orchestrate-types";

const ACTIVE_ORCHESTRATION = "active-orchestration";

export type UnsupportedOrchestrateState = {
	kind: "unsupported";
	name: string;
	path: string;
	reason: string;
};

export type OrchestrateStateRecord = { kind: "state"; state: OrchestrateState } | UnsupportedOrchestrateState;

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
		schemaVersion: ORCHESTRATE_SCHEMA_VERSION,
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
	await writeFile(orchestrateNotePathFor(cwd, name), formatInitialOrchestrateNote(state), "utf8");
	await writeOrchestrateState(cwd, state);
	return state;
}

export async function writeOrchestrateState(cwd: string, state: OrchestrateState): Promise<void> {
	await mkdir(ralphDir(cwd), { recursive: true });
	await writeFile(
		orchestrateStatePathFor(cwd, state.name),
		`${JSON.stringify({ ...state, schemaVersion: ORCHESTRATE_SCHEMA_VERSION }, null, 2)}\n`,
		"utf8",
	);
}

export async function readOrchestrateState(cwd: string, name: string): Promise<OrchestrateState> {
	const normalized = name.replace(/\.state\.json$/, "");
	const file = orchestrateStatePathFor(cwd, normalized);
	return parseOrchestrateState(JSON.parse(await readFile(file, "utf8")), file);
}

export async function listOrchestrateStates(cwd: string): Promise<OrchestrateState[]> {
	const records = await listOrchestrateStateRecords(cwd);
	return records
		.filter((record): record is { kind: "state"; state: OrchestrateState } => record.kind === "state")
		.map((record) => record.state);
}

export async function listOrchestrateStateRecords(cwd: string): Promise<OrchestrateStateRecord[]> {
	const dir = ralphDir(cwd);
	if (!existsSync(dir)) return [];
	const records: OrchestrateStateRecord[] = [];
	for (const file of await readdir(dir)) {
		if (!file.startsWith("orchestrate-") || !file.endsWith(".state.json")) continue;
		const filePath = path.join(dir, file);
		try {
			records.push({
				kind: "state",
				state: parseOrchestrateState(JSON.parse(await readFile(filePath, "utf8")), filePath),
			});
		} catch (error) {
			records.push({
				kind: "unsupported",
				name: file.replace(/\.state\.json$/, ""),
				path: filePath,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return records.sort((a, b) => recordStartedAt(b).localeCompare(recordStartedAt(a)));
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

function parseOrchestrateState(value: unknown, file: string): OrchestrateState {
	if (!value || typeof value !== "object") throw new Error(`Malformed orchestration state in ${file}.`);
	const state = value as Partial<OrchestrateState>;
	if (state.schemaVersion !== ORCHESTRATE_SCHEMA_VERSION) {
		throw new Error(`expected schemaVersion ${ORCHESTRATE_SCHEMA_VERSION}`);
	}
	if (typeof state.name !== "string" || typeof state.startedAt !== "string" || !Array.isArray(state.issueRuns)) {
		throw new Error(`Malformed orchestration state in ${file}.`);
	}
	return state as OrchestrateState;
}

function recordStartedAt(record: OrchestrateStateRecord): string {
	return record.kind === "state" ? record.state.startedAt : "";
}
