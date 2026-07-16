import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendRalphNote,
	archiveRalphStateFiles,
	deleteRalphNote,
	deleteRalphState,
	ensureRalphStateStorage,
	getActiveRalphStateName,
	iterationPathFor,
	listRalphStateRecords,
	notePathFor,
	readRalphState,
	setActiveRalphStateName,
	statePathFor,
	writeJsonAtomically,
	writeRalphState,
} from "./ralph-state-storage";

type ExampleState = { schemaVersion: 1; name: string; startedAt: string; value: string };

async function tempRepo(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "ralph-state-storage-"));
}

function parseExampleState(value: unknown, file: string): ExampleState {
	if (!value || typeof value !== "object") throw new Error(`Malformed example state in ${file}.`);
	const state = value as Partial<ExampleState>;
	if (state.schemaVersion !== 1) throw new Error("expected schemaVersion 1");
	if (typeof state.name !== "string" || typeof state.startedAt !== "string") {
		throw new Error(`Malformed example state in ${file}.`);
	}
	return state as ExampleState;
}

describe("Ralph state storage", () => {
	it("keeps iteration records inside the Ralph iteration directory", async () => {
		const cwd = await tempRepo();

		const file = iterationPathFor(cwd, "../../session", 7, "../../../target");

		expect(path.relative(cwd, file)).toBe(path.join(".ralph", "iterations", "session", "000007-target.json"));
	});

	it("preserves the previous JSON file when an atomic rename fails", async () => {
		const cwd = await tempRepo();
		const file = path.join(cwd, "record.json");
		await writeFile(file, '{"value":"previous"}\n', "utf8");

		const renameSources: string[] = [];
		await expect(
			writeJsonAtomically(
				file,
				{ value: "replacement" },
				{
					rename: async (source) => {
						renameSources.push(source);
						throw new Error("rename failed");
					},
				},
			),
		).rejects.toThrow("rename failed");

		expect(renameSources.map((source) => path.dirname(source))).toEqual([cwd]);
		expect(await readFile(file, "utf8")).toBe('{"value":"previous"}\n');
		expect(await readdir(cwd)).toEqual(["record.json"]);
	});

	it("writes, reads, lists, and reports unsupported state records for one prefix", async () => {
		const cwd = await tempRepo();
		await writeRalphState(cwd, "example-one", {
			schemaVersion: 1,
			name: "example-one",
			startedAt: "2026-01-01T00:00:00.000Z",
			value: "ok",
		});
		await writeFile(statePathFor(cwd, "example-old"), '{"schemaVersion":0,"name":"example-old"}\n', "utf8");
		await writeFile(statePathFor(cwd, "other-old"), '{"schemaVersion":0,"name":"other-old"}\n', "utf8");

		expect(await readRalphState(cwd, "example-one", parseExampleState)).toMatchObject({ value: "ok" });

		const records = await listRalphStateRecords(cwd, { prefix: "example-", parse: parseExampleState });
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({ kind: "state", state: { name: "example-one" } });
		expect(records[1]).toMatchObject({ kind: "unsupported", name: "example-old" });
	});

	it("keeps Ralph storage out of git by default", async () => {
		const cwd = await tempRepo();
		await mkdir(path.join(cwd, ".git", "info"), { recursive: true });
		await writeFile(path.join(cwd, ".git", "info", "exclude"), "node_modules/\n", "utf8");

		await ensureRalphStateStorage(cwd);
		await ensureRalphStateStorage(cwd);

		expect(await readFile(path.join(cwd, ".ralph", ".gitignore"), "utf8")).toBe("*\n!.gitignore\n");
		expect(await readFile(path.join(cwd, ".git", "info", "exclude"), "utf8")).toBe(
			"node_modules/\n\n# Matt Ralph internal orchestration state\n.ralph/\n",
		);
	});

	it("owns active markers, notes, deletion, and archive moves", async () => {
		const cwd = await tempRepo();
		const state: ExampleState = {
			schemaVersion: 1,
			name: "example-two",
			startedAt: "2026-01-01T00:00:00.000Z",
			value: "ok",
		};
		await writeRalphState(cwd, state.name, state);
		await appendRalphNote(cwd, state.name, "first");
		await appendRalphNote(cwd, state.name, " second");
		await writeJsonAtomically(iterationPathFor(cwd, state.name, 1, "text:example"), { outcome: "accepted" });
		await setActiveRalphStateName(cwd, "active-example", state.name);

		expect(await getActiveRalphStateName(cwd, "active-example")).toBe(state.name);
		expect(await readFile(notePathFor(cwd, state.name), "utf8")).toBe("first second");

		await archiveRalphStateFiles(cwd, state.name);
		expect(existsSync(statePathFor(cwd, state.name))).toBe(false);
		expect(existsSync(notePathFor(cwd, state.name))).toBe(false);
		expect(await readRalphState(cwd, state.name, parseExampleState, { archive: true })).toMatchObject({
			name: state.name,
		});
		expect(await readFile(notePathFor(cwd, state.name, { archive: true }), "utf8")).toBe("first second");
		expect(existsSync(iterationPathFor(cwd, state.name, 1, "text:example"))).toBe(false);
		expect(path.relative(cwd, iterationPathFor(cwd, state.name, 1, "text:example", { archive: true }))).toBe(
			path.join(".ralph", "archive", "iterations", state.name, "000001-text-example.json"),
		);
		expect(
			JSON.parse(await readFile(iterationPathFor(cwd, state.name, 1, "text:example", { archive: true }), "utf8")),
		).toEqual({ outcome: "accepted" });

		await deleteRalphState(cwd, state.name, { archive: true });
		await deleteRalphNote(cwd, state.name, { archive: true });
		expect(existsSync(statePathFor(cwd, state.name, { archive: true }))).toBe(false);
		expect(existsSync(notePathFor(cwd, state.name, { archive: true }))).toBe(false);
	});
});
