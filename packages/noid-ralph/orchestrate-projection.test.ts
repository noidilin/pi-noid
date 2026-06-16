import { describe, expect, it } from "vitest";
import { formatOrchestrateStatusLine, formatParentSummary } from "./orchestrate-projection";
import { ORCHESTRATE_SCHEMA_VERSION, type OrchestrateState } from "./orchestrate-types";

function state(): OrchestrateState {
	return {
		schemaVersion: ORCHESTRATE_SCHEMA_VERSION,
		name: "orchestrate-issue-42-abc123",
		parentIssue: 42,
		parentTitle: "Parent",
		status: "active",
		startedAt: "2026-01-01T00:00:00.000Z",
		issueTimeoutMs: 120_000,
		currentIndex: 0,
		plan: {
			parent: { number: 42, title: "Parent" },
			allChildren: [],
			openChildren: [],
			skippedClosed: [{ number: 33, title: "Done", state: "closed", source: "native", order: 0 }],
			dependenciesByIssue: {},
			plannedOrder: [],
			blockers: [],
			cycles: [],
			valid: true,
		},
		issueRuns: [
			{
				issue: 34,
				title: "Do thing",
				status: "running",
				sessionName: "implement-issue-34-run",
				startedAt: "2026-01-01T00:00:05.000Z",
				workerLaunchedAt: "2026-01-01T00:00:06.000Z",
				workerExitCode: 0,
				initialDirtyStatus: " M .ralph/foo.state.json",
			},
		],
		herdr: { paneId: "pane-1" },
	};
}

describe("orchestrate projection", () => {
	it("formats status from provided state and time without reading time itself", () => {
		const line = formatOrchestrateStatusLine({
			state: state(),
			notePath: ".ralph/orchestrate-issue-42-abc123.md",
			childStatesByName: new Map([
				[
					"implement-issue-34-run",
					{
						name: "implement-issue-34-run",
						status: "active",
						startedAt: "2026-01-01T00:00:07.000Z",
						initialDirtyStatus: " M .ralph/bar.state.json",
					},
				],
			]),
			now: "2026-01-01T00:01:06.000Z",
		});

		expect(line).toContain("orchestrate-issue-42-abc123: active, 0/1, parent #42");
		expect(line).toContain("duration 1m 6s");
		expect(line).toContain("current: #34 running");
		expect(line).toContain("worker 1m 0s");
		expect(line).toContain("ralph 59s");
		expect(line).toContain("ralph-only dirt: 1 child session(s)");
	});

	it("formats parent summary with caller-provided completion time", () => {
		const runState = state();
		runState.issueRuns[0] = { ...runState.issueRuns[0], status: "completed", commits: ["abc123 change"] };
		const summary = formatParentSummary(runState, "2026-01-01T00:02:00.000Z");

		expect(summary).toContain("Run: orchestrate-issue-42-abc123");
		expect(summary).toContain("#34 Do thing — completed — commits: abc123 change");
		expect(summary).toContain("Completed: 2026-01-01T00:02:00.000Z");
	});
});
