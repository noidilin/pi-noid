import { describe, expect, it } from "vitest";
import { type ChildRunAdapters, type ChildRunProgress, runChildIssue } from "./child-run";
import type { HerdrWorkerRunSpec } from "./herdr-runner";
import type { MattRalphState } from "./types";

const input = {
	cwd: "/repo",
	orchestrationName: "orchestrate-issue-42-abc123",
	index: 0,
	issue: 34,
	title: "Do the thing",
	paneId: "pane-1",
	issueTimeoutMs: 120_000,
};

type AdapterOptions = {
	workerExited?: boolean;
	childState?: Partial<MattRalphState>;
	issueClosed?: boolean;
	commits?: string;
};

function createAdapters(options: AdapterOptions = {}): ChildRunAdapters & {
	scripts: string[];
	workerRuns: HerdrWorkerRunSpec[];
} {
	let revParseCount = 0;
	const scripts: string[] = [];
	const workerRuns: HerdrWorkerRunSpec[] = [];
	const childState: MattRalphState = {
		name: "placeholder",
		taskFile: ".ralph/placeholder.md",
		status: "completed",
		mode: "implement",
		rootIssue: "#34",
		childIssues: [{ number: 34, title: "Do the thing", source: "standalone" }],
		currentIndex: 0,
		iteration: 1,
		startedAt: "2026-01-01T00:00:03.000Z",
		completedAt: "2026-01-01T00:00:04.000Z",
		...options.childState,
	};
	return {
		scripts,
		workerRuns,
		now: (() => {
			let tick = 0;
			return () => `2026-01-01T00:00:0${tick++}.000Z`;
		})(),
		git: async (args) => {
			if (args[0] === "rev-parse") return revParseCount++ === 0 ? "head-before" : "head-after";
			if (args[0] === "log") return options.commits ?? "abc123 commit one";
			throw new Error(`unexpected git args: ${args.join(" ")}`);
		},
		writeWorkerScript: async (_file, content) => {
			scripts.push(content);
		},
		runWorkerScript: async (spec) => {
			workerRuns.push(spec);
			await spec.onLaunched?.();
			return {
				exited: options.workerExited ?? true,
				exitCode: 0,
				tail: `some output\nRALPH_WORKER_EXIT issue=34 code=0 sentinel=${spec.sentinel}\n`,
			};
		},
		findRalphSession: async (sessionName) => ({ ...childState, name: sessionName }),
		isIssueClosed: async () => options.issueClosed ?? true,
	};
}

describe("child run", () => {
	it("returns a completed outcome with progress facts", async () => {
		const adapters = createAdapters();
		const progress: ChildRunProgress[] = [];
		const outcome = await runChildIssue(input, adapters, (event) => {
			progress.push(event);
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.facts).toMatchObject({
			sessionName: "implement-issue-34-orchestrate-issue-42-abc123-1-issue-34",
			headBefore: "head-before",
			headAfter: "head-after",
			commits: ["abc123 commit one"],
			workerExitCode: 0,
		});
		expect(progress.map((event) => event.type)).toEqual([
			"started",
			"workerScriptWritten",
			"workerLaunched",
			"workerExited",
			"childStateRead",
			"completed",
		]);
		expect(adapters.scripts[0]).toContain(
			"/ralph implement #34 --exit-on-complete --ignore-ralph-dirty --session-suffix orchestrate-issue-42-abc123-1-issue-34",
		);
		expect(adapters.workerRuns[0]).toMatchObject({
			paneId: "pane-1",
			scriptPath: "/repo/.ralph/orchestrate-issue-42-abc123-issue-34.worker.sh",
			timeoutMs: 120_000,
		});
	});

	it("returns a failed outcome when the worker times out", async () => {
		const outcome = await runChildIssue(input, createAdapters({ workerExited: false }));

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected failure");
		expect(outcome.reason).toBe("Worker timed out before sentinel.");
		expect(outcome.diagnostics.paneTail).toContain("RALPH_WORKER_EXIT");
	});

	it("returns a failed outcome when the child Ralph session is incomplete", async () => {
		const outcome = await runChildIssue(input, createAdapters({ childState: { status: "active" } }));

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected failure");
		expect(outcome.reason).toBe("Child Ralph session did not complete.");
		expect(outcome.diagnostics.childStatus).toBe("active");
	});

	it("returns a failed outcome when the GitHub child issue is open", async () => {
		const outcome = await runChildIssue(input, createAdapters({ issueClosed: false }));

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected failure");
		expect(outcome.reason).toBe("GitHub child issue is still open.");
	});

	it("returns a failed outcome when no commits were produced", async () => {
		const outcome = await runChildIssue(input, createAdapters({ commits: "" }));

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected failure");
		expect(outcome.reason).toBe("No commits were produced for child issue.");
	});
});
