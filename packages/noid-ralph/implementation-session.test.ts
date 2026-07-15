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
	it("resolves a GitHub parent issue to its discovered children", async () => {
		const cwd = await tempRepo();
		const children = [
			{ number: 35, title: "First child", source: "native" as const, state: "open" as const },
			{ number: 36, title: "Second child", source: "parent-section" as const, state: "closed" as const },
		];
		const prepared = await prepareImplementationSessionStart(
			{ cwd, targetArg: "#34" },
			createAdapters({ discoverChildren: async (parent) => (parent === 34 ? children : []) }),
		);

		expect(prepared).toMatchObject({
			ok: true,
			prepared: {
				target: { kind: "github", raw: "#34", number: 34 },
				parentIssue: 34,
				children,
			},
		});
	});

	it("resolves a GitHub child issue without rediscovering its parent's children", async () => {
		const cwd = await tempRepo();
		let discovered = false;
		const prepared = await prepareImplementationSessionStart(
			{ cwd, targetArg: "#35" },
			createAdapters({
				viewIssue: async () => ({
					number: 35,
					title: "Child issue",
					state: "open",
					parent: { number: 34, title: "Parent issue" },
				}),
				discoverChildren: async () => {
					discovered = true;
					return [];
				},
			}),
		);

		expect(discovered).toBe(false);
		expect(prepared).toMatchObject({
			ok: true,
			prepared: {
				parentIssue: 34,
				children: [{ number: 35, title: "Child issue", state: "open", source: "standalone" }],
			},
		});
	});

	it("resolves a standalone GitHub issue as its own single-target plan", async () => {
		const cwd = await tempRepo();
		const prepared = await prepareImplementationSessionStart(
			{ cwd, targetArg: "https://github.com/acme/repo/issues/37" },
			createAdapters({
				viewIssue: async () => ({ number: 37, title: "Standalone issue", state: "open" }),
			}),
		);

		expect(prepared).toMatchObject({
			ok: true,
			prepared: {
				target: { kind: "github", number: 37 },
				parentIssue: 37,
				children: [{ number: 37, title: "Standalone issue", state: "open", source: "standalone" }],
			},
		});
	});

	it("distinguishes local Markdown paths, missing paths, and free-text targets", async () => {
		const cwd = await tempRepo();
		const adapters = createAdapters({ targetExists: (file) => file.endsWith("docs/plan.md") });

		const localPath = await prepareImplementationSessionStart({ cwd, targetArg: "docs/plan.md" }, adapters);
		const missingPath = await prepareImplementationSessionStart({ cwd, targetArg: "docs/missing.md" }, adapters);
		const freeText = await prepareImplementationSessionStart(
			{ cwd, targetArg: "write characterization tests" },
			adapters,
		);

		expect(localPath).toMatchObject({
			ok: true,
			prepared: {
				target: { kind: "path", raw: "docs/plan.md", path: "docs/plan.md" },
				children: [{ number: 0, title: "docs/plan.md", source: "standalone" }],
			},
		});
		expect(missingPath).toEqual({
			ok: false,
			effects: [{ type: "notify", message: "Target file not found: docs/missing.md", level: "error" }],
		});
		expect(freeText).toMatchObject({
			ok: true,
			prepared: {
				target: { kind: "text", raw: "write characterization tests" },
				children: [{ number: 0, title: "write characterization tests", source: "standalone" }],
			},
		});
	});

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
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "event", name: "matt_ralph:start" }));
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
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "event", name: "matt_ralph:advance" }));
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
		expect(result.effects).toContainEqual({
			type: "event",
			name: "matt_ralph:pause",
			payload: { name: "implement-issue-34" },
		});
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
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "event", name: "matt_ralph:complete" }));
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "notify", level: "warning" }));
		expect(await readFile(notePathFor(cwd, "implement-issue-34"), "utf8")).toContain("close failed");
	});

	it("finalizes child issues and their root parent exactly once", async () => {
		const cwd = await tempRepo();
		await writeActiveState(
			cwd,
			createState({
				rootIssue: "#34",
				parentIssue: 34,
				childIssues: [
					{ number: 35, title: "First child", source: "native", state: "open" },
					{ number: 36, title: "Second child", source: "parent-section", state: "open" },
				],
			}),
		);
		const finalized: number[] = [];

		await completeImplementationSession({
			cwd,
			adapters: createAdapters({
				finalizeIssue: async (issue) => {
					finalized.push(issue);
					return { issue, commented: true, closed: true };
				},
			}),
		});

		expect(finalized).toEqual([35, 36, 34]);
	});

	it("finalizes only a targeted child when its parent is context rather than the root", async () => {
		const cwd = await tempRepo();
		await writeActiveState(
			cwd,
			createState({
				rootIssue: "#35",
				parentIssue: 34,
				childIssues: [{ number: 35, title: "Child issue", source: "standalone", state: "open" }],
			}),
		);
		const finalized: number[] = [];

		await completeImplementationSession({
			cwd,
			adapters: createAdapters({
				finalizeIssue: async (issue) => {
					finalized.push(issue);
					return { issue, commented: true, closed: true };
				},
			}),
		});

		expect(finalized).toEqual([35]);
	});

	it("skips GitHub finalization for local targets and when gh is unavailable", async () => {
		const localCwd = await tempRepo();
		await writeActiveState(
			localCwd,
			createState({
				rootIssue: "docs/plan.md",
				parentIssue: undefined,
				childIssues: [{ number: 0, title: "docs/plan.md", source: "standalone" }],
			}),
		);
		const githubCwd = await tempRepo();
		await writeActiveState(githubCwd);
		const finalized: number[] = [];
		const adapters = createAdapters({
			hasCommand: async () => false,
			finalizeIssue: async (issue) => {
				finalized.push(issue);
				return { issue, commented: true, closed: true };
			},
		});

		const local = await completeImplementationSession({ cwd: localCwd, adapters });
		const github = await completeImplementationSession({ cwd: githubCwd, adapters });

		expect(finalized).toEqual([]);
		expect(local.effects).toContainEqual(
			expect.objectContaining({ type: "notify", message: expect.stringContaining("No GitHub issue targets") }),
		);
		expect(github.effects).toContainEqual(
			expect.objectContaining({ type: "notify", message: expect.stringContaining("gh is not available") }),
		);
	});
});
