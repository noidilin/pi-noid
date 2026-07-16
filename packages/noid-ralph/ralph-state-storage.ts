import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
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

type AtomicJsonAdapters = {
	rename?: (source: string, destination: string) => Promise<void>;
};

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

export function iterationDirectoryFor(cwd: string, sessionName: string, options: RalphStateFileOptions = {}): string {
	const root = options.archive
		? path.join(ralphArchiveDir(cwd), "iterations")
		: path.join(ralphDir(cwd), "iterations");
	return path.join(root, safeIterationPathPart(sessionName));
}

export function iterationPathFor(
	cwd: string,
	sessionName: string,
	iteration: number,
	targetKey: string,
	options: RalphStateFileOptions = {},
): string {
	const target = safeIterationPathPart(targetKey);
	return path.join(
		iterationDirectoryFor(cwd, sessionName, options),
		`${String(iteration).padStart(6, "0")}-${target}.json`,
	);
}

export async function ensureRalphStateStorage(cwd: string): Promise<void> {
	await mkdir(ralphArchiveDir(cwd), { recursive: true });
	await ensureRalphGitIgnores(cwd);
}

export async function ensureRalphGitIgnores(cwd: string): Promise<void> {
	await writeFile(path.join(ralphDir(cwd), ".gitignore"), "*\n!.gitignore\n", "utf8");
	const repository = await findGitRepository(cwd);
	if (!repository) return;
	const relativeRalphDir = toGitPath(path.relative(repository.workTree, ralphDir(cwd))) || ".ralph";
	await appendUniqueLine(
		path.join(repository.gitDir, "info", "exclude"),
		`${relativeRalphDir}/`,
		`\n# Matt Ralph internal orchestration state\n${relativeRalphDir}/\n`,
	);
}

export async function writeJsonAtomically(
	file: string,
	value: unknown,
	adapters: AtomicJsonAdapters = {},
): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const temporaryFile = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await (adapters.rename ?? rename)(temporaryFile, file);
	} catch (error) {
		await rm(temporaryFile, { force: true });
		throw error;
	}
}

export async function writeRalphState<TState extends { name: string }>(
	cwd: string,
	name: string,
	state: TState,
	options: RalphStateFileOptions = {},
): Promise<void> {
	await ensureRalphStateStorage(cwd);
	await mkdir(options.archive ? ralphArchiveDir(cwd) : ralphDir(cwd), { recursive: true });
	await writeJsonAtomically(statePathFor(cwd, name, options), state);
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
	await ensureRalphStateStorage(cwd);
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

export async function deleteRalphIterations(
	cwd: string,
	name: string,
	options: RalphStateFileOptions = {},
): Promise<void> {
	await rm(iterationDirectoryFor(cwd, name, options), { force: true, recursive: true });
}

export async function archiveRalphStateFiles(cwd: string, name: string): Promise<void> {
	await ensureRalphStateStorage(cwd);
	const sourceState = statePathFor(cwd, name);
	if (existsSync(sourceState)) await rename(sourceState, statePathFor(cwd, name, { archive: true }));
	const sourceNote = notePathFor(cwd, name);
	if (existsSync(sourceNote)) await rename(sourceNote, notePathFor(cwd, name, { archive: true }));
	const sourceIterations = iterationDirectoryFor(cwd, name);
	if (existsSync(sourceIterations)) {
		const archivedIterations = iterationDirectoryFor(cwd, name, { archive: true });
		await mkdir(path.dirname(archivedIterations), { recursive: true });
		await rename(sourceIterations, archivedIterations);
	}
}

type GitRepository = { workTree: string; gitDir: string };

async function findGitRepository(cwd: string): Promise<GitRepository | undefined> {
	let current = path.resolve(cwd);
	while (true) {
		const dotGit = path.join(current, ".git");
		if (existsSync(dotGit)) {
			const gitDir = statSync(dotGit).isDirectory() ? dotGit : await readGitFileGitDir(dotGit, current);
			if (gitDir) return { workTree: current, gitDir };
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function readGitFileGitDir(dotGitFile: string, workTree: string): Promise<string | undefined> {
	const content = await readFile(dotGitFile, "utf8").catch(() => "");
	const match = content.match(/^gitdir:\s*(.+)\s*$/m);
	if (!match) return undefined;
	return path.resolve(workTree, match[1]);
}

async function appendUniqueLine(file: string, line: string, block: string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const current = existsSync(file) ? await readFile(file, "utf8") : "";
	if (current.split(/\r?\n/).includes(line)) return;
	await writeFile(file, `${current}${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${block}`, "utf8");
}

function toGitPath(value: string): string {
	return value.split(path.sep).filter(Boolean).join("/");
}

function safeIterationPathPart(value: string): string {
	return (
		value
			.trim()
			.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.replace(/^[._-]+|[._-]+$/g, "") || "unnamed"
	);
}

function recordStartedAt<TState>(
	record: RalphStateRecord<TState>,
	startedAt: ((state: TState) => string | undefined) | undefined,
): string {
	return record.kind === "state" ? (startedAt?.(record.state) ?? "") : "";
}
