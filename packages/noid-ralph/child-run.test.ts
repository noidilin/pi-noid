import { describe, expect, it } from "vitest";
import { type ChildRunAdapters, type ChildRunProgress, runChildIssue, verifyClosedChildRun } from "./child-run";
import type { HerdrWorkerRunSpec } from "./herdr-runner";
import type { OrchestrateIssueRun } from "./orchestrate-types";
import { MATT_RALPH_SCHEMA_VERSION, type MattRalphState } from "./types";

function createRun(overrides: Partial<OrchestrateIssueRun> = {}): OrchestrateIssueRun {
	return { issue: 34, title: "Do the thing", status: "pending", ...overrides };
}

function createInput(run = createRun()) {
	return {
		cwd: "/repo",
		orchestrationName: "orchestrate-issue-42-abc123",
		index: 0,
		run,
		parentIssue: 42,
		parentStatePath: "/repo/.ralph/orchestrate-issue-42-abc123.state.json",
		paneId: "pane-1",
		issueTimeoutMs: 120_000,
	};
}

const link = {
	orchestrationName: "orchestrate-issue-42-abc123",
	parentIssue: 42,
	childIssue: 34,
	issueRunIndex: 0,
	parentStatePath: "/repo/.ralph/orchestrate-issue-42-abc123.state.json",
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
		schemaVersion: MATT_RALPH_SCHEMA_VERSION,
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
		orchestrationChildLink: link,
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
	it("applies completed child run facts to the orchestration state contract", async () => {
		const run = createRun();
		const input = createInput(run);
		const adapters = createAdapters();
		const progress: ChildRunProgress[] = [];
		const stateSnapshots: OrchestrateIssueRun[] = [];
		const outcome = await runChildIssue(input, adapters, (event) => {
			progress.push(event);
			stateSnapshots.push({ ...run });
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
		expect(stateSnapshots.map((snapshot) => snapshot.status)).toEqual([
			"running",
			"running",
			"running",
			"running",
			"running",
			"completed",
		]);
		expect(run).toMatchObject({
			status: "completed",
			startedAt: "2026-01-01T00:00:00.000Z",
			headBefore: "head-before",
			sessionName: "implement-issue-34-orchestrate-issue-42-abc123-1-issue-34",
			workerScript: ".ralph/orchestrate-issue-42-abc123-issue-34.worker.sh",
			workerLaunchedAt: "2026-01-01T00:00:01.000Z",
			workerExitedAt: "2026-01-01T00:00:02.000Z",
			workerExitCode: 0,
			ralphStartedAt: "2026-01-01T00:00:03.000Z",
			ralphCompletedAt: "2026-01-01T00:00:04.000Z",
			completedAt: "2026-01-01T00:00:03.000Z",
			headAfter: "head-after",
			commits: ["abc123 commit one"],
		});
		expect(adapters.scripts[0]).toContain(
			"/ralph implement #34 --exit-on-complete --ignore-ralph-dirty --session-suffix orchestrate-issue-42-abc123-1-issue-34 --orchestrator-name orchestrate-issue-42-abc123 --orchestrator-parent-issue 42 --orchestrator-child-issue 34 --orchestrator-issue-run-index 0 --orchestrator-state-path /repo/.ralph/orchestrate-issue-42-abc123.state.json",
		);
		expect(adapters.workerRuns[0]).toMatchObject({
			paneId: "pane-1",
			scriptPath: "/repo/.ralph/orchestrate-issue-42-abc123-issue-34.worker.sh",
			timeoutMs: 120_000,
		});
	});

	it("applies failed child run facts when the worker times out", async () => {
		const run = createRun();
		const outcome = await runChildIssue(createInput(run), createAdapters({ workerExited: false }));

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected failure");
		expect(outcome.reason).toBe("Worker timed out before sentinel.");
		expect(outcome.diagnostics.paneTail).toContain("RALPH_WORKER_EXIT");
		expect(run).toMatchObject({
			status: "failed",
			error: "Worker timed out before sentinel.",
			workerExitedAt: "2026-01-01T00:00:02.000Z",
			workerExitCode: 0,
		});
	});

	it("returns a failed outcome when the child Ralph session is incomplete", async () => {
		const run = createRun();
		const outcome = await runChildIssue(createInput(run), createAdapters({ childState: { status: "active" } }));

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected failure");
		expect(outcome.reason).toBe("Child Ralph session did not complete.");
		expect(outcome.diagnostics.childStatus).toBe("active");
		expect(run.status).toBe("failed");
	});

	it("returns a failed outcome when the child Ralph session link is missing", async () => {
		const run = createRun();
		const outcome = await runChildIssue(
			createInput(run),
			createAdapters({ childState: { orchestrationChildLink: undefined } }),
		);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected failure");
		expect(outcome.reason).toBe("Child Ralph session link is missing or mismatched.");
		expect(run.status).toBe("failed");
	});

	it("returns a failed outcome when the GitHub child issue is open", async () => {
		const run = createRun();
		const outcome = await runChildIssue(createInput(run), createAdapters({ issueClosed: false }));

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected failure");
		expect(outcome.reason).toBe("GitHub child issue is still open.");
		expect(run.status).toBe("failed");
	});

	it("returns a failed outcome when no commits were produced", async () => {
		const run = createRun();
		const outcome = await runChildIssue(createInput(run), createAdapters({ commits: "" }));

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected failure");
		expect(outcome.reason).toBe("No commits were produced for child issue.");
		expect(run.status).toBe("failed");
	});

	it("verifies a closed child run during resume through the same state contract", async () => {
		const run = createRun({ sessionName: "implement-issue-34-orchestrate-issue-42-abc123-1-issue-34" });
		const progress: string[] = [];
		const outcome = await verifyClosedChildRun(createInput(run), createAdapters(), (event) => {
			progress.push(event.type);
		});

		expect(outcome.ok).toBe(true);
		expect(progress).toEqual(["childStateRead", "resumeVerified"]);
		expect(run).toMatchObject({
			status: "completed",
			completedAt: "2026-01-01T00:00:00.000Z",
			ralphStartedAt: "2026-01-01T00:00:03.000Z",
			ralphCompletedAt: "2026-01-01T00:00:04.000Z",
		});
	});

	it("fails closed child run resume verification when the orchestration child link is missing", async () => {
		const run = createRun({ sessionName: "implement-issue-34-orchestrate-issue-42-abc123-1-issue-34" });
		const outcome = await verifyClosedChildRun(
			createInput(run),
			createAdapters({ childState: { orchestrationChildLink: undefined } }),
		);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected failure");
		expect(outcome.reason).toBe("Resume found closed child #34 without its expected orchestration child link.");
		expect(run.status).toBe("failed");
	});
});
