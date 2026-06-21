import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listStateRecords, writeState } from "./loop-store";
import { statePathFor } from "./ralph-state-storage";
import { MATT_RALPH_SCHEMA_VERSION, type MattRalphState } from "./types";

async function tempRepo(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "loop-store-"));
}

function createState(overrides: Partial<MattRalphState> = {}): MattRalphState {
	return {
		schemaVersion: MATT_RALPH_SCHEMA_VERSION,
		name: "implement-issue-34",
		taskFile: ".ralph/implement-issue-34.md",
		status: "active",
		mode: "implement",
		rootIssue: "#34",
		childIssues: [{ number: 34, title: "Do thing", source: "standalone" }],
		currentIndex: 0,
		iteration: 1,
		startedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("loop store", () => {
	it("lists supported Implementation sessions and unsupported Implementation records", async () => {
		const cwd = await tempRepo();
		await writeState(cwd, createState());
		await writeFile(statePathFor(cwd, "implement-old"), '{"schemaVersion":1,"name":"implement-old"}\n', "utf8");
		await writeFile(statePathFor(cwd, "orchestrate-old"), '{"schemaVersion":1,"name":"orchestrate-old"}\n', "utf8");

		const records = await listStateRecords(cwd);

		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({ kind: "state", state: { name: "implement-issue-34" } });
		expect(records[1]).toMatchObject({ kind: "unsupported", name: "implement-old" });
	});
});
