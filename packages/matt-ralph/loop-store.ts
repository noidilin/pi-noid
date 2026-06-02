import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MattRalphState } from "./types";

const ACTIVE_FILE = "active-session";

export function ralphDir(cwd: string): string {
	return path.join(cwd, ".ralph");
}

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

export function statePathFor(cwd: string, name: string): string {
	return path.join(ralphDir(cwd), `${name}.state.json`);
}

export function archivedStatePathFor(cwd: string, name: string): string {
	return path.join(ralphDir(cwd), "archive", `${name}.state.json`);
}

export function taskPathFor(cwd: string, name: string): string {
	return path.join(ralphDir(cwd), `${name}.md`);
}

export function archivedTaskPathFor(cwd: string, name: string): string {
	return path.join(ralphDir(cwd), "archive", `${name}.md`);
}

export async function ensureStore(cwd: string): Promise<void> {
	await mkdir(path.join(ralphDir(cwd), "archive"), { recursive: true });
}

export async function writeState(cwd: string, state: MattRalphState): Promise<void> {
	await ensureStore(cwd);
	await writeFile(statePathFor(cwd, state.name), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function readState(cwd: string, name: string): Promise<MattRalphState> {
	const raw = await readFile(statePathFor(cwd, name), "utf8");
	return JSON.parse(raw) as MattRalphState;
}

export async function setActiveSession(cwd: string, name: string | undefined): Promise<void> {
	await ensureStore(cwd);
	await writeFile(path.join(ralphDir(cwd), ACTIVE_FILE), name ? `${name}\n` : "", "utf8");
}

export async function getActiveSessionName(cwd: string): Promise<string | undefined> {
	const file = path.join(ralphDir(cwd), ACTIVE_FILE);
	if (!existsSync(file)) return undefined;
	const name = (await readFile(file, "utf8")).trim();
	return name || undefined;
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

export async function listStates(cwd: string): Promise<MattRalphState[]> {
	const dir = ralphDir(cwd);
	if (!existsSync(dir)) return [];
	const files = await readdir(dir);
	const states: MattRalphState[] = [];
	for (const file of files.filter((name) => name.endsWith(".state.json"))) {
		try {
			states.push(JSON.parse(await readFile(path.join(dir, file), "utf8")) as MattRalphState);
		} catch {
			// Ignore malformed session files in status output.
		}
	}
	return states.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function listArchivedStates(cwd: string): Promise<MattRalphState[]> {
	const dir = path.join(ralphDir(cwd), "archive");
	if (!existsSync(dir)) return [];
	const files = await readdir(dir);
	const states: MattRalphState[] = [];
	for (const file of files.filter((name) => name.endsWith(".state.json"))) {
		try {
			states.push(JSON.parse(await readFile(path.join(dir, file), "utf8")) as MattRalphState);
		} catch {
			// Ignore malformed archived session files.
		}
	}
	return states.sort((a, b) => (b.archivedAt ?? b.startedAt).localeCompare(a.archivedAt ?? a.startedAt));
}

export async function deleteState(cwd: string, name: string): Promise<void> {
	await rm(statePathFor(cwd, name), { force: true });
	if ((await getActiveSessionName(cwd)) === name) await setActiveSession(cwd, undefined);
}

export async function deleteTask(cwd: string, state: MattRalphState): Promise<void> {
	const file = path.isAbsolute(state.taskFile) ? state.taskFile : path.join(cwd, state.taskFile);
	await rm(file, { force: true });
}

export async function archiveState(cwd: string, state: MattRalphState): Promise<MattRalphState> {
	await ensureStore(cwd);
	const archived: MattRalphState = {
		...state,
		archivedAt: new Date().toISOString(),
		taskFile: path.relative(cwd, archivedTaskPathFor(cwd, state.name)),
	};
	const sourceTask = path.isAbsolute(state.taskFile) ? state.taskFile : path.join(cwd, state.taskFile);
	if (existsSync(sourceTask)) await rename(sourceTask, archivedTaskPathFor(cwd, state.name));
	await writeFile(archivedStatePathFor(cwd, state.name), `${JSON.stringify(archived, null, 2)}\n`, "utf8");
	await rm(statePathFor(cwd, state.name), { force: true });
	if ((await getActiveSessionName(cwd)) === state.name) await setActiveSession(cwd, undefined);
	return archived;
}

export async function appendTaskNote(cwd: string, state: MattRalphState, note: string): Promise<void> {
	const file = path.isAbsolute(state.taskFile) ? state.taskFile : path.join(cwd, state.taskFile);
	const current = existsSync(file) ? await readFile(file, "utf8") : "";
	await writeFile(file, current + note, "utf8");
}
