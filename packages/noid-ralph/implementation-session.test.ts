import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	advanceImplementationSession,
	completeImplementationSession,
	type ImplementationSessionAdapters,
	prepareImplementationSessionStart,
	resumeImplementationSession,
	startImplementationSession,
	stopImplementationSession,
} from "./implementation-session";
import { getActiveState, readState, setActiveSession, writeState } from "./loop-store";
import { notePathFor } from "./ralph-state-storage";
import { MATT_RALPH_SCHEMA_VERSION, type MattRalphState } from "./types";

async function tempRepo(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "implementation-session-"));
}

function createAdapters(overrides: Partial<ImplementationSessionAdapters> = {}): ImplementationSessionAdapters {
	return {
		now: (() => {
			let tick = 0;
			return () => `2026-01-01T00:00:0${tick++}.000Z`;
		})(),
		targetExists: (file) => file.includes("/AGENTS.md") || file.includes("/.agents/skills/"),
		isGitRepo: async () => true,
		dirtyStatus: async () => "",
		dirtyStatusExcludingRalph: async () => "",
		hasCommand: async () => true,
		viewIssue: async (issue) => ({ number: issue, title: `Issue ${issue}`, state: "open" }),
		discoverChildren: async () => [],
		finalizeIssue: async (issue) => ({ issue, commented: true, closed: true }),
		...overrides,
	};
}

function createState(overrides: Partial<MattRalphState> = {}): MattRalphState {
	return {
		schemaVersion: MATT_RALPH_SCHEMA_VERSION,
		name: "implement-issue-34",
		taskFile: ".ralph/implement-issue-34.md",
		status: "active",
		mode: "implement",
		rootIssue: "#34",
		parentIssue: 34,
		childIssues: [{ number: 34, title: "Do thing", source: "standalone", state: "open" }],
		currentIndex: 0,
		iteration: 1,
		startedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

async function writeActiveState(cwd: string, state = createState()): Promise<MattRalphState> {
	await writeState(cwd, state);
	await setActiveSession(cwd, state.name);
	return state;
}

describe("implementation session", () => {
	it("prepares dirty worktree confirmation then starts a durable Implementation session", async () => {
		const cwd = await tempRepo();
		const prepared = await prepareImplementationSessionStart(
			{ cwd, targetArg: "write tests", ignoreRalphDirty: true },
			createAdapters({
				dirtyStatus: async () => " M .ralph/notes.md\n M src/app.ts",
				dirtyStatusExcludingRalph: async () => " M src/app.ts",
			}),
		);

		expect(prepared.ok).toBe(true);
		if (!prepared.ok) throw new Error("expected prepare success");
		expect(prepared.confirmation?.message).toContain("M src/app.ts");

		const result = await startImplementationSession(prepared.prepared);
		expect(result.effects.map((effect) => effect.type)).toEqual(["updateUi", "event", "notify", "prompt"]);
		expect(result.state).toMatchObject({
			name: "implement-write-tests",
			status: "active",
			initialDirtyStatus: " M src/app.ts",
			ignoredDirtyStatus: " M .ralph/notes.md",
		});
		expect((await getActiveState(cwd))?.name).toBe("implement-write-tests");
		expect(await readFile(notePathFor(cwd, "implement-write-tests"), "utf8")).toContain("## Preflight");
	});

	it("advances to final verification through an effect list", async () => {
		const cwd = await tempRepo();
		await writeActiveState(cwd);

		const result = await advanceImplementationSession({
			cwd,
			hasPendingMessages: false,
			adapters: createAdapters(),
		});

		expect(result.message).toBe("All Matt Ralph targets processed. Queued final verification prompt.");
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "prompt", deliverAs: "followUp" }));
		expect((await readState(cwd, "implement-issue-34")).currentIndex).toBe(1);
	});

	it("pauses through advance when max iterations are exceeded", async () => {
		const cwd = await tempRepo();
		await writeActiveState(cwd, createState({ maxIterations: 1 }));

		const result = await advanceImplementationSession({
			cwd,
			hasPendingMessages: false,
			adapters: createAdapters(),
		});

		expect(result.message).toContain("paused after exceeding max iterations");
		expect(result.effects).toContainEqual({ type: "updateUi", state: undefined });
		expect((await readState(cwd, "implement-issue-34")).status).toBe("paused");
	});

	it("resumes and stops active Implementation sessions without command-shell mutation", async () => {
		const cwd = await tempRepo();
		await writeState(cwd, createState({ status: "paused" }));

		const resumed = await resumeImplementationSession(cwd, "implement-issue-34", createAdapters());
		expect(resumed.effects.map((effect) => effect.type)).toEqual(["updateUi", "prompt"]);
		expect((await readState(cwd, "implement-issue-34")).status).toBe("active");

		const stopped = await stopImplementationSession(cwd);
		expect(stopped.effects.map((effect) => effect.type)).toEqual(["updateUi", "event", "notify"]);
		expect((await readState(cwd, "implement-issue-34")).status).toBe("paused");
	});

	it("completes even when GitHub finalization fails and returns a warning effect", async () => {
		const cwd = await tempRepo();
		await writeActiveState(cwd);

		const result = await completeImplementationSession({
			cwd,
			adapters: createAdapters({
				finalizeIssue: async (issue) => ({ issue, commented: true, closed: false, error: "close failed" }),
			}),
		});

		expect((await readState(cwd, "implement-issue-34")).status).toBe("completed");
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "notify", level: "warning" }));
		expect(await readFile(notePathFor(cwd, "implement-issue-34"), "utf8")).toContain("close failed");
	});
});
