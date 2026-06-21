import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOrchestrateState, listOrchestrateStateRecords, readOrchestrateState } from "./orchestrate-store";
import { ORCHESTRATE_SCHEMA_VERSION, type OrchestratePlan } from "./orchestrate-types";
import { statePathFor } from "./ralph-state-storage";

function plan(): OrchestratePlan {
	return {
		parent: { number: 42, title: "Parent" },
		allChildren: [],
		openChildren: [],
		skippedClosed: [],
		dependenciesByIssue: {},
		plannedOrder: [{ number: 34, title: "Do thing", state: "open", source: "native", order: 0 }],
		blockers: [],
		cycles: [],
		valid: true,
	};
}

describe("orchestrate store", () => {
	it("writes and reads the strict current schema version", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "ralph-store-"));
		const state = await createOrchestrateState(cwd, { number: 42, title: "Parent" }, plan(), {
			issueTimeoutMs: 120_000,
		});
		const read = await readOrchestrateState(cwd, state.name);

		expect(read.schemaVersion).toBe(ORCHESTRATE_SCHEMA_VERSION);
		expect(read.issueRuns).toEqual([{ issue: 34, title: "Do thing", status: "pending" }]);
	});

	it("reports unsupported old schemas in records", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "ralph-store-"));
		await mkdir(path.join(cwd, ".ralph"), { recursive: true });
		await writeFile(statePathFor(cwd, "orchestrate-issue-42-old"), JSON.stringify({ name: "old" }));
		const records = await listOrchestrateStateRecords(cwd);

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			kind: "unsupported",
			name: "orchestrate-issue-42-old",
			reason: `expected schemaVersion ${ORCHESTRATE_SCHEMA_VERSION}`,
		});
	});
});
