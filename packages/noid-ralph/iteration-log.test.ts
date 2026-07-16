import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openIterationRecord } from "./iteration-log";
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
});
