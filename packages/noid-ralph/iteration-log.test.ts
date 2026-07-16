import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	closeIterationRecord,
	openIterationRecord,
	persistChildRunProgress,
	readIterationRecord,
	updateIterationRecord,
} from "./iteration-log";
import { iterationPathFor } from "./ralph-state-storage";

describe("Ralph iteration log", () => {
	it("durably opens a running implementation attempt", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "ralph-iteration-log-"));

		const opened = await openIterationRecord(cwd, {
			sessionName: "implement-example",
			iteration: 1,
			targetKey: "text:example",
			targetTitle: "Example target",
			source: "text",
			startedAt: "2026-03-13T12:00:00.000Z",
			acceptanceCriteria: [{ id: "works", text: "It works", source: "section" }],
		});

		const file = iterationPathFor(cwd, "implement-example", 1, "text:example");
		expect(opened.path).toBe(file);
		expect(opened.record).toEqual({
			schemaVersion: 1,
			sessionName: "implement-example",
			iteration: 1,
			targetKey: "text:example",
			targetTitle: "Example target",
			source: "text",
			startedAt: "2026-03-13T12:00:00.000Z",
			outcome: "running",
			acceptanceCriteria: [{ id: "works", text: "It works", source: "section" }],
		});
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual(opened.record);
	});

	it("does not overwrite an existing running attempt", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "ralph-iteration-log-"));
		const input = {
			sessionName: "implement-example",
			iteration: 1,
			targetKey: "text:example",
			targetTitle: "Example target",
			source: "text" as const,
			startedAt: "2026-03-13T12:00:00.000Z",
			acceptanceCriteria: [],
		};
		const opened = await openIterationRecord(cwd, input);

		await expect(
			openIterationRecord(cwd, {
				...input,
				targetTitle: "Replacement target",
				startedAt: "2026-03-13T13:00:00.000Z",
			}),
		).rejects.toThrow("Iteration attempt is already running");

		expect(JSON.parse(await readFile(opened.path, "utf8"))).toEqual(opened.record);
	});

	it("rejects malformed iteration evidence when reading", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "ralph-iteration-log-"));
		const file = iterationPathFor(cwd, "implement-example", 1, "text:example");
		await openIterationRecord(cwd, {
			sessionName: "implement-example",
			iteration: 1,
			targetKey: "text:example",
			targetTitle: "Example target",
			source: "text",
			startedAt: "2026-03-13T12:00:00.000Z",
			acceptanceCriteria: [],
		});
		const malformed = JSON.parse(await readFile(file, "utf8"));
		malformed.acceptanceCriteria = [{ id: 42, text: "It works", source: "section" }];
		await writeFile(file, `${JSON.stringify(malformed)}\n`, "utf8");

		await expect(readIterationRecord(cwd, "implement-example", 1, "text:example")).rejects.toThrow(
			"Malformed Ralph iteration record",
		);
	});

	it("atomically closes a running attempt with its terminal facts", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "ralph-iteration-log-"));
		await openIterationRecord(cwd, {
			sessionName: "implement-example",
			iteration: 1,
			targetKey: "text:example",
			targetTitle: "Example target",
			source: "text",
			startedAt: "2026-03-13T12:00:00.000Z",
			headBefore: "abc123",
			acceptanceCriteria: [],
		});

		const closed = await closeIterationRecord(cwd, {
			sessionName: "implement-example",
			iteration: 1,
			targetKey: "text:example",
			outcome: "accepted",
			endedAt: "2026-03-13T12:30:00.000Z",
			headAfter: "def456",
			commits: ["def456"],
		});

		expect(closed).toMatchObject({
			outcome: "accepted",
			endedAt: "2026-03-13T12:30:00.000Z",
			headBefore: "abc123",
			headAfter: "def456",
			commits: ["def456"],
		});
		expect(await readIterationRecord(cwd, "implement-example", 1, "text:example")).toEqual(closed);
	});

	it("round-trips accepted completion and validation evidence", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "ralph-iteration-log-"));
		await openIterationRecord(cwd, {
			sessionName: "implement-example",
			iteration: 1,
			targetKey: "text:example",
			targetTitle: "Example target",
			source: "text",
			startedAt: "2026-03-13T12:00:00.000Z",
			acceptanceCriteria: [{ id: "works", text: "It works", source: "section" }],
		});
		const completionEvidence = {
			summary: "Implemented the target.",
			criteria: [{ criterionId: "works", evidence: "Covered by the integration test." }],
			validation: [{ command: "pnpm test", outcome: "98 tests passed" }],
			commit: "def456",
			notesUpdated: true,
		};

		await closeIterationRecord(cwd, {
			sessionName: "implement-example",
			iteration: 1,
			targetKey: "text:example",
			outcome: "accepted",
			endedAt: "2026-03-13T12:30:00.000Z",
			completionEvidence,
			validation: completionEvidence.validation,
		});

		expect(await readIterationRecord(cwd, "implement-example", 1, "text:example")).toMatchObject({
			completionEvidence,
			validation: completionEvidence.validation,
		});
	});

	it("round-trips rejection reasons without accepting the attempt", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "ralph-iteration-log-"));
		await openIterationRecord(cwd, {
			sessionName: "implement-example",
			iteration: 1,
			targetKey: "text:example",
			targetTitle: "Example target",
			source: "text",
			startedAt: "2026-03-13T12:00:00.000Z",
			acceptanceCriteria: [],
		});

		await closeIterationRecord(cwd, {
			sessionName: "implement-example",
			iteration: 1,
			targetKey: "text:example",
			outcome: "rejected",
			endedAt: "2026-03-13T12:30:00.000Z",
			rejectionReasons: ["Validation evidence is required."],
		});

		expect(await readIterationRecord(cwd, "implement-example", 1, "text:example")).toMatchObject({
			outcome: "rejected",
			rejectionReasons: ["Validation evidence is required."],
		});
	});

	it("persists child-run progress with bounded pane diagnostics", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "ralph-iteration-log-"));
		await openIterationRecord(cwd, {
			sessionName: "orchestrate-issue-42",
			iteration: 1,
			targetKey: "github:34",
			targetTitle: "Issue 34",
			source: "github",
			startedAt: "2026-03-13T12:00:00.000Z",
			headBefore: "abc123",
			acceptanceCriteria: [],
		});

		await updateIterationRecord(cwd, {
			sessionName: "orchestrate-issue-42",
			iteration: 1,
			targetKey: "github:34",
			childRun: {
				workerScript: ".ralph/worker.sh",
				workerLaunchedAt: "2026-03-13T12:01:00.000Z",
				workerExitedAt: "2026-03-13T12:02:00.000Z",
				workerExitCode: 1,
				paneTail: `prefix-${"x".repeat(5_000)}`,
			},
		});

		const record = await readIterationRecord(cwd, "orchestrate-issue-42", 1, "github:34");
		expect(record.childRun).toMatchObject({ workerScript: ".ralph/worker.sh", workerExitCode: 1 });
		expect(record.childRun?.paneTail).toHaveLength(4_000);
		expect(record.childRun?.paneTail).toBe("x".repeat(4_000));
	});

	it("persists a failed child run from progress facts", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "ralph-iteration-log-"));
		const identity = { orchestrationName: "orchestrate-issue-42", index: 0, issue: 34, title: "Issue 34" };
		await persistChildRunProgress(cwd, identity, {
			type: "started",
			facts: { startedAt: "2026-03-13T12:00:00.000Z", headBefore: "abc123", sessionName: "implement-34" },
		});
		await persistChildRunProgress(cwd, identity, {
			type: "workerExited",
			facts: { workerExitedAt: "2026-03-13T12:02:00.000Z", workerExitCode: 1 },
		});
		await persistChildRunProgress(cwd, identity, {
			type: "failed",
			reason: "Worker failed.",
			facts: { completedAt: "2026-03-13T12:03:00.000Z", headAfter: "def456", commits: ["def456 work"] },
			diagnostics: { paneTail: `secret-prefix-${"z".repeat(5_000)}` },
		});

		const record = await readIterationRecord(cwd, "orchestrate-issue-42", 1, "github:34");
		expect(record).toMatchObject({
			outcome: "failed",
			endedAt: "2026-03-13T12:03:00.000Z",
			headBefore: "abc123",
			headAfter: "def456",
			commits: ["def456 work"],
			failureReason: "Worker failed.",
			childRun: { workerExitedAt: "2026-03-13T12:02:00.000Z", workerExitCode: 1 },
		});
		expect(record.childRun?.paneTail).toBe("z".repeat(4_000));
	});

	it("records a child failure that occurs before the started progress event", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "ralph-iteration-log-"));
		const identity = { orchestrationName: "orchestrate-issue-42", index: 0, issue: 34, title: "Issue 34" };

		await persistChildRunProgress(cwd, identity, {
			type: "failed",
			reason: "Could not read HEAD.",
			facts: { startedAt: "2026-03-13T12:00:00.000Z", completedAt: "2026-03-13T12:00:01.000Z" },
			diagnostics: {},
		});

		expect(await readIterationRecord(cwd, "orchestrate-issue-42", 1, "github:34")).toMatchObject({
			outcome: "failed",
			startedAt: "2026-03-13T12:00:00.000Z",
			endedAt: "2026-03-13T12:00:01.000Z",
			failureReason: "Could not read HEAD.",
		});
	});

	it("interrupts a stale running child attempt before opening its retry", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "ralph-iteration-log-"));
		const first = { orchestrationName: "orchestrate-issue-42", index: 0, issue: 34, title: "Issue 34" };
		await persistChildRunProgress(cwd, first, {
			type: "started",
			facts: { startedAt: "2026-03-13T12:00:00.000Z", headBefore: "abc123", sessionName: "implement-34" },
		});

		await persistChildRunProgress(
			cwd,
			{ ...first, index: 1 },
			{
				type: "started",
				facts: { startedAt: "2026-03-13T13:00:00.000Z", headBefore: "def456", sessionName: "implement-34-retry" },
			},
		);

		expect(await readIterationRecord(cwd, "orchestrate-issue-42", 1, "github:34")).toMatchObject({
			outcome: "interrupted",
			endedAt: "2026-03-13T13:00:00.000Z",
			failureReason: "Superseded by child-run retry 2.",
		});
		expect(await readIterationRecord(cwd, "orchestrate-issue-42", 2, "github:34")).toMatchObject({
			outcome: "running",
		});
	});
});
