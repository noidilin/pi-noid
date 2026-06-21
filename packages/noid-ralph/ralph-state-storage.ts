import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type RalphStateFileOptions = { archive?: boolean };

export type UnsupportedStateRecord = {
	kind: "unsupported";
	name: string;
	path: string;
	reason: string;
};

export type RalphStateRecord<TState> = { kind: "state"; state: TState } | UnsupportedStateRecord;

export type RalphStateParser<TState> = (value: unknown, file: string) => TState;

export function ralphDir(cwd: string): string {
	return path.join(cwd, ".ralph");
}

export function ralphArchiveDir(cwd: string): string {
	return path.join(ralphDir(cwd), "archive");
}

export function statePathFor(cwd: string, name: string, options: RalphStateFileOptions = {}): string {
	return path.join(options.archive ? ralphArchiveDir(cwd) : ralphDir(cwd), `${name}.state.json`);
}

export function notePathFor(cwd: string, name: string, options: RalphStateFileOptions = {}): string {
	return path.join(options.archive ? ralphArchiveDir(cwd) : ralphDir(cwd), `${name}.md`);
}

export async function ensureRalphStateStorage(cwd: string): Promise<void> {
	await mkdir(ralphArchiveDir(cwd), { recursive: true });
}

export async function writeRalphState<TState extends { name: string }>(
	cwd: string,
	name: string,
	state: TState,
	options: RalphStateFileOptions = {},
): Promise<void> {
	await mkdir(options.archive ? ralphArchiveDir(cwd) : ralphDir(cwd), { recursive: true });
	await writeFile(statePathFor(cwd, name, options), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function readRalphState<TState>(
	cwd: string,
	name: string,
	parse: RalphStateParser<TState>,
	options: RalphStateFileOptions = {},
): Promise<TState> {
	const normalized = name.replace(/\.state\.json$/, "");
	const file = statePathFor(cwd, normalized, options);
	return parse(JSON.parse(await readFile(file, "utf8")), file);
}

export async function listRalphStateRecords<TState>(
	cwd: string,
	input: {
		prefix?: string;
		archive?: boolean;
		parse: RalphStateParser<TState>;
		startedAt?: (state: TState) => string | undefined;
	},
): Promise<RalphStateRecord<TState>[]> {
	const dir = input.archive ? ralphArchiveDir(cwd) : ralphDir(cwd);
	if (!existsSync(dir)) return [];
	const records: RalphStateRecord<TState>[] = [];
	for (const fileName of await readdir(dir)) {
		if (!fileName.endsWith(".state.json")) continue;
		if (input.prefix && !fileName.startsWith(input.prefix)) continue;
		const file = path.join(dir, fileName);
		try {
			records.push({ kind: "state", state: input.parse(JSON.parse(await readFile(file, "utf8")), file) });
		} catch (error) {
			records.push({
				kind: "unsupported",
				name: fileName.replace(/\.state\.json$/, ""),
				path: file,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return records.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "state" ? -1 : 1;
		return recordStartedAt(b, input.startedAt).localeCompare(recordStartedAt(a, input.startedAt));
	});
}

export async function setActiveRalphStateName(cwd: string, marker: string, name: string | undefined): Promise<void> {
	await ensureRalphStateStorage(cwd);
	await writeFile(path.join(ralphDir(cwd), marker), name ? `${name}\n` : "", "utf8");
}

export async function getActiveRalphStateName(cwd: string, marker: string): Promise<string | undefined> {
	const file = path.join(ralphDir(cwd), marker);
	if (!existsSync(file)) return undefined;
	const name = (await readFile(file, "utf8")).trim();
	return name || undefined;
}

export async function appendRalphNote(
	cwd: string,
	name: string,
	markdown: string,
	options: RalphStateFileOptions = {},
): Promise<void> {
	await mkdir(options.archive ? ralphArchiveDir(cwd) : ralphDir(cwd), { recursive: true });
	const file = notePathFor(cwd, name, options);
	const current = existsSync(file) ? await readFile(file, "utf8") : "";
	await writeFile(file, current + markdown, "utf8");
}

export async function deleteRalphState(cwd: string, name: string, options: RalphStateFileOptions = {}): Promise<void> {
	await rm(statePathFor(cwd, name, options), { force: true });
}

export async function deleteRalphNote(cwd: string, name: string, options: RalphStateFileOptions = {}): Promise<void> {
	await rm(notePathFor(cwd, name, options), { force: true });
}

export async function archiveRalphStateFiles(cwd: string, name: string): Promise<void> {
	await ensureRalphStateStorage(cwd);
	const sourceState = statePathFor(cwd, name);
	if (existsSync(sourceState)) await rename(sourceState, statePathFor(cwd, name, { archive: true }));
	const sourceNote = notePathFor(cwd, name);
	if (existsSync(sourceNote)) await rename(sourceNote, notePathFor(cwd, name, { archive: true }));
}

function recordStartedAt<TState>(
	record: RalphStateRecord<TState>,
	startedAt: ((state: TState) => string | undefined) | undefined,
): string {
	return record.kind === "state" ? (startedAt?.(record.state) ?? "") : "";
}
