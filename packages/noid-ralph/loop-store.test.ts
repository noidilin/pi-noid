import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteState, deleteTask, listStateRecords, readState, writeState } from "./loop-store";
import { iterationPathFor, notePathFor, statePathFor, writeJsonAtomically } from "./ralph-state-storage";
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
		targetPlan: {
			root: {
				key: "github:34",
				source: "github",
				title: "Do thing",
				issueNumber: 34,
				acceptanceCriteria: [],
				acceptanceCriteriaResolved: true,
			},
			targets: [
				{
					key: "github:34",
					source: "github",
					title: "Do thing",
					issueNumber: 34,
					issueSource: "standalone",
					acceptanceCriteria: [],
					acceptanceCriteriaResolved: true,
				},
			],
		},
		currentIndex: 0,
		iteration: 1,
		startedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("loop store", () => {
	it("migrates a persisted schema-v2 implementation session with unresolved acceptance", async () => {
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

		await expect(readState(cwd, fixture.name)).resolves.toEqual({
			...fixture,
			schemaVersion: 3,
			targetPlan: {
				root: {
					key: "github:34",
					source: "github",
					title: "Issue #34",
					issueNumber: 34,
					acceptanceCriteria: [],
					acceptanceCriteriaResolved: false,
				},
				targets: [
					{
						key: "github:35",
						source: "github",
						title: "Do thing",
						issueNumber: 35,
						parentIssueNumber: 34,
						state: "open",
						issueSource: "native",
						acceptanceCriteria: [],
						acceptanceCriteriaResolved: false,
					},
				],
			},
		});
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

	it("preserves diagnostics when deleting state and removes them only for clean-all", async () => {
		const cwd = await tempRepo();
		const state = createState({ status: "completed" });
		await writeState(cwd, state);
		await writeFile(notePathFor(cwd, state.name), "notes\n", "utf8");
		await writeJsonAtomically(iterationPathFor(cwd, state.name, 1, "github:34"), { outcome: "accepted" });

		await deleteState(cwd, state.name);
		expect(existsSync(statePathFor(cwd, state.name))).toBe(false);
		expect(existsSync(notePathFor(cwd, state.name))).toBe(true);
		expect(existsSync(iterationPathFor(cwd, state.name, 1, "github:34"))).toBe(true);

		await deleteTask(cwd, state);
		expect(existsSync(notePathFor(cwd, state.name))).toBe(false);
		expect(existsSync(iterationPathFor(cwd, state.name, 1, "github:34"))).toBe(false);
	});
});
