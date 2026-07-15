import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listStateRecords, readState, writeState } from "./loop-store";
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
	it("parses a persisted schema-v2 implementation session", async () => {
		const cwd = await tempRepo();
		const fixture = {
			schemaVersion: 2,
			name: "implement-v2-fixture",
			taskFile: ".ralph/implement-v2-fixture.md",
			status: "paused",
			mode: "implement",
			rootIssue: "#34",
			parentIssue: 34,
			childIssues: [{ number: 35, title: "Do thing", state: "open", source: "native" }],
			currentIndex: 0,
			iteration: 2,
			startedAt: "2026-01-01T00:00:00.000Z",
			initialDirtyStatus: " M src/existing.ts",
		};
		const fixturePath = statePathFor(cwd, fixture.name);
		await mkdir(path.dirname(fixturePath), { recursive: true });
		await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`, "utf8");

		await expect(readState(cwd, fixture.name)).resolves.toEqual(fixture);
	});

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
