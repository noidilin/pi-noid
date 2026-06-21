import { formatInitialOrchestrateNote } from "./orchestrate-projection";
import { ORCHESTRATE_SCHEMA_VERSION, type OrchestratePlan, type OrchestrateState } from "./orchestrate-types";
import {
	appendRalphNote,
	ensureRalphStateStorage,
	getActiveRalphStateName,
	listRalphStateRecords,
	readRalphState,
	setActiveRalphStateName,
	type UnsupportedStateRecord,
	writeRalphState,
} from "./ralph-state-storage";

const ACTIVE_ORCHESTRATION = "active-orchestration";
const ORCHESTRATE_PREFIX = "orchestrate-";

export type UnsupportedOrchestrateState = UnsupportedStateRecord;
export type OrchestrateStateRecord = { kind: "state"; state: OrchestrateState } | UnsupportedOrchestrateState;

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
	await ensureRalphStateStorage(cwd);
	await appendRalphNote(cwd, name, formatInitialOrchestrateNote(state));
	await writeOrchestrateState(cwd, state);
	return state;
}

export async function writeOrchestrateState(cwd: string, state: OrchestrateState): Promise<void> {
	await writeRalphState(cwd, state.name, { ...state, schemaVersion: ORCHESTRATE_SCHEMA_VERSION });
}

export async function readOrchestrateState(cwd: string, name: string): Promise<OrchestrateState> {
	return readRalphState(cwd, name, parseOrchestrateState);
}

export async function listOrchestrateStates(cwd: string): Promise<OrchestrateState[]> {
	const records = await listOrchestrateStateRecords(cwd);
	return records
		.filter((record): record is { kind: "state"; state: OrchestrateState } => record.kind === "state")
		.map((record) => record.state);
}

export async function listOrchestrateStateRecords(cwd: string): Promise<OrchestrateStateRecord[]> {
	return listRalphStateRecords(cwd, {
		prefix: ORCHESTRATE_PREFIX,
		parse: parseOrchestrateState,
		startedAt: (state) => state.startedAt,
	});
}

export async function setActiveOrchestration(cwd: string, name: string | undefined): Promise<void> {
	await setActiveRalphStateName(cwd, ACTIVE_ORCHESTRATION, name);
}

export async function getActiveOrchestration(cwd: string): Promise<string | undefined> {
	return getActiveRalphStateName(cwd, ACTIVE_ORCHESTRATION);
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
