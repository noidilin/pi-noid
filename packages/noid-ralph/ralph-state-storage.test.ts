import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendRalphNote,
	archiveRalphStateFiles,
	deleteRalphNote,
	deleteRalphState,
	getActiveRalphStateName,
	listRalphStateRecords,
	notePathFor,
	readRalphState,
	setActiveRalphStateName,
	statePathFor,
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

		await deleteRalphState(cwd, state.name, { archive: true });
		await deleteRalphNote(cwd, state.name, { archive: true });
		expect(existsSync(statePathFor(cwd, state.name, { archive: true }))).toBe(false);
		expect(existsSync(notePathFor(cwd, state.name, { archive: true }))).toBe(false);
	});
});
