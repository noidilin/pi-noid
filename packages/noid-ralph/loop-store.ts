import path from "node:path";
import {
	archiveRalphStateFiles,
	deleteRalphNote,
	deleteRalphState,
	ensureRalphStateStorage,
	getActiveRalphStateName,
	listRalphStateRecords,
	notePathFor,
	readRalphState,
	setActiveRalphStateName,
	type UnsupportedStateRecord,
	writeRalphState,
} from "./ralph-state-storage";
import { MATT_RALPH_SCHEMA_VERSION, type MattRalphState } from "./types";

const ACTIVE_FILE = "active-session";
const IMPLEMENT_PREFIX = "implement-";

export type UnsupportedMattRalphState = UnsupportedStateRecord;
export type MattRalphStateRecord = { kind: "state"; state: MattRalphState } | UnsupportedMattRalphState;

export function sanitizeSessionName(input: string): string {
	const cleaned = input
		.trim()
		.replace(/^https?:\/\/[^/]+\//, "")
		.replace(/^#/, "issue-")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return cleaned || "session";
}

function archivedTaskPathFor(cwd: string, name: string): string {
	return notePathFor(cwd, name, { archive: true });
}

async function ensureStore(cwd: string): Promise<void> {
	await ensureRalphStateStorage(cwd);
}

export async function writeState(cwd: string, state: MattRalphState): Promise<void> {
	await writeRalphState(cwd, state.name, { ...state, schemaVersion: MATT_RALPH_SCHEMA_VERSION });
}

export async function readState(cwd: string, name: string): Promise<MattRalphState> {
	return readRalphState(cwd, name, parseMattRalphState);
}

export async function setActiveSession(cwd: string, name: string | undefined): Promise<void> {
	await setActiveRalphStateName(cwd, ACTIVE_FILE, name);
}

export async function getActiveSessionName(cwd: string): Promise<string | undefined> {
	return getActiveRalphStateName(cwd, ACTIVE_FILE);
}

export async function getActiveState(cwd: string): Promise<MattRalphState | undefined> {
	const activeName = await getActiveSessionName(cwd);
	if (activeName) {
		try {
			const state = await readState(cwd, activeName);
			if (state.status === "active") return state;
		} catch {
			// Fall through to scan.
		}
	}
	const states = await listStates(cwd);
	return states.filter((state) => state.status === "active").sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

export async function listStateRecords(cwd: string): Promise<MattRalphStateRecord[]> {
	return listRalphStateRecords(cwd, {
		prefix: IMPLEMENT_PREFIX,
		parse: parseMattRalphState,
		startedAt: (state) => state.startedAt,
	});
}

export async function listStates(cwd: string): Promise<MattRalphState[]> {
	return (await listStateRecords(cwd))
		.filter((record): record is { kind: "state"; state: MattRalphState } => record.kind === "state")
		.map((record) => record.state);
}

export async function listArchivedStateRecords(cwd: string): Promise<MattRalphStateRecord[]> {
	return listRalphStateRecords(cwd, {
		prefix: IMPLEMENT_PREFIX,
		archive: true,
		parse: parseMattRalphState,
		startedAt: (state) => state.archivedAt ?? state.startedAt,
	});
}

export async function listArchivedStates(cwd: string): Promise<MattRalphState[]> {
	return (await listArchivedStateRecords(cwd))
		.filter((record): record is { kind: "state"; state: MattRalphState } => record.kind === "state")
		.map((record) => record.state);
}

export async function deleteState(cwd: string, name: string): Promise<void> {
	await deleteRalphState(cwd, name);
	if ((await getActiveSessionName(cwd)) === name) await setActiveSession(cwd, undefined);
}

export async function deleteTask(cwd: string, state: MattRalphState): Promise<void> {
	await deleteRalphNote(cwd, state.name);
}

export async function archiveState(cwd: string, state: MattRalphState): Promise<MattRalphState> {
	await ensureStore(cwd);
	const archived: MattRalphState = {
		...state,
		archivedAt: new Date().toISOString(),
		taskFile: path.relative(cwd, archivedTaskPathFor(cwd, state.name)),
	};
	await archiveRalphStateFiles(cwd, state.name);
	await writeRalphState(cwd, state.name, archived, { archive: true });
	if ((await getActiveSessionName(cwd)) === state.name) await setActiveSession(cwd, undefined);
	return archived;
}

function parseMattRalphState(value: unknown, file: string): MattRalphState {
	if (!isMattRalphState(value)) throw new Error(`Unsupported Matt Ralph state schema in ${file}.`);
	return value;
}

function isMattRalphState(value: unknown): value is MattRalphState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<MattRalphState>;
	return (
		state.schemaVersion === MATT_RALPH_SCHEMA_VERSION &&
		state.mode === "implement" &&
		typeof state.name === "string" &&
		Array.isArray(state.childIssues)
	);
}
