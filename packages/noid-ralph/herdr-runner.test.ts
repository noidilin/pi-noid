import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runChildRalphSessionWorker } from "./herdr-runner";

type ExecCall = { command: string; args: string[]; options?: unknown };

function createPi(options: { waitCode?: number } = {}) {
	const calls: ExecCall[] = [];
	let lastWaitMatch = "sentinel=test.sentinel";
	return {
		calls,
		pi: {
			exec: async (command: string, args: string[], execOptions?: unknown) => {
				calls.push({ command, args, options: execOptions });
				if (args[0] === "pane" && args[1] === "run") return { code: 0, stdout: "", stderr: "" };
				if (args[0] === "wait" && args[1] === "output") {
					lastWaitMatch = String(args[4] ?? lastWaitMatch);
					return { code: options.waitCode ?? 0, stdout: "", stderr: "" };
				}
				if (args[0] === "pane" && args[1] === "read") {
					return {
						code: 0,
						stdout: `tail\nRALPH_WORKER_EXIT issue=34 code=7 ${lastWaitMatch}\n`,
						stderr: "",
					};
				}
				throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
			},
		},
	};
}

async function withTempCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const tmp = await mkdtemp(path.join(tmpdir(), "ralph-herdr-"));
	try {
		const cwd = path.join(tmp, "repo's-copy");
		await mkdir(cwd, { recursive: true });
		return await fn(cwd);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

describe("herdr runner", () => {
	it("runs one child Ralph session behind the Herdr worker adapter", async () => {
		await withTempCwd(async (cwd) => {
			const { pi, calls } = createPi();
			const events: string[] = [];
			let tick = 0;
			const result = await runChildRalphSessionWorker(
				pi as never,
				{
					cwd,
					paneId: "pane-1",
					orchestrationName: "orchestrate-issue-42-abc123",
					issue: 34,
					prompt: "/ralph implement #34 --exit-on-complete",
					timeoutMs: 120_000,
					tailLines: 20,
					now: () => `2026-01-01T00:00:0${tick++}.000Z`,
				},
				(event) => {
					events.push(event.type);
				},
			);

			expect(result).toMatchObject({
				workerScript: ".ralph/orchestrate-issue-42-abc123-issue-34.worker.sh",
				workerLaunchedAt: "2026-01-01T00:00:00.000Z",
				workerExitedAt: "2026-01-01T00:00:01.000Z",
				exited: true,
				workerExitCode: 7,
			});
			expect(result.sentinel).toMatch(/^issue-34-/);
			expect(result.paneTail).toContain(`sentinel=${result.sentinel}`);
			expect(events).toEqual(["workerScriptWritten", "workerLaunched", "workerExited"]);

			const script = await readFile(path.join(cwd, result.workerScript), "utf8");
			expect(script).toContain("pi --name 'ralph #34' '/ralph implement #34 --exit-on-complete'");
			expect(script).toContain(`RALPH_WORKER_EXIT issue=34 code=%s sentinel=${result.sentinel}`);
			expect(calls[0]?.args).toEqual([
				"pane",
				"run",
				"pane-1",
				`sh '${path.join(cwd, result.workerScript).replaceAll("'", "'\\''")}'`,
			]);
			expect(calls[1]?.args).toEqual([
				"wait",
				"output",
				"pane-1",
				"--match",
				`sentinel=${result.sentinel}`,
				"--timeout",
				"120000",
			]);
			expect(calls[2]?.args).toEqual(["pane", "read", "pane-1", "--source", "recent-unwrapped", "--lines", "20"]);
		});
	});

	it("returns exited=false when the child Ralph session sentinel wait times out", async () => {
		await withTempCwd(async (cwd) => {
			const { pi } = createPi({ waitCode: 1 });
			let tick = 0;
			const result = await runChildRalphSessionWorker(pi as never, {
				cwd,
				paneId: "pane-1",
				orchestrationName: "orchestrate-issue-42-abc123",
				issue: 34,
				prompt: "/ralph implement #34 --exit-on-complete",
				timeoutMs: 120_000,
				now: () => `2026-01-01T00:00:0${tick++}.000Z`,
			});

			expect(result.exited).toBe(false);
			expect(result.workerExitCode).toBe(7);
			expect(result.paneTail).toContain(`sentinel=${result.sentinel}`);
		});
	});
});
