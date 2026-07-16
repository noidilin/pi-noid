import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeIterationRecord, openIterationRecord, readIterationRecord } from "./iteration-log";
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
});
