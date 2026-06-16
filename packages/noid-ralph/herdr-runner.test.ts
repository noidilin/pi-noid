import { describe, expect, it } from "vitest";
import { createChildRalphWorkerScript, parseWorkerExitCode, runWorkerScriptInPane } from "./herdr-runner";

type ExecCall = { command: string; args: string[]; options?: unknown };

function createPi(options: { waitCode?: number } = {}) {
	const calls: ExecCall[] = [];
	return {
		calls,
		pi: {
			exec: async (command: string, args: string[], execOptions?: unknown) => {
				calls.push({ command, args, options: execOptions });
				if (args[0] === "pane" && args[1] === "run") return { code: 0, stdout: "", stderr: "" };
				if (args[0] === "wait" && args[1] === "output")
					return { code: options.waitCode ?? 0, stdout: "", stderr: "" };
				if (args[0] === "pane" && args[1] === "read") {
					return {
						code: 0,
						stdout: "tail\nRALPH_WORKER_EXIT issue=34 code=7 sentinel=test.sentinel\n",
						stderr: "",
					};
				}
				throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
			},
		},
	};
}

describe("herdr runner", () => {
	it("creates a child Ralph script with a private sentinel line", () => {
		const script = createChildRalphWorkerScript({
			issue: 34,
			prompt: "/ralph implement #34 --exit-on-complete",
			sentinel: "sentinel-1",
		});

		expect(script.sentinel).toBe("sentinel-1");
		expect(script.content).toContain("pi --name 'ralph #34' '/ralph implement #34 --exit-on-complete'");
		expect(script.content).toContain("RALPH_WORKER_EXIT issue=34 code=%s sentinel=sentinel-1");
	});

	it("runs a worker script in a pane and returns structured completion facts", async () => {
		const { pi, calls } = createPi();
		let launched = false;
		const result = await runWorkerScriptInPane(pi as never, "/repo", {
			paneId: "pane-1",
			scriptPath: "/repo/.ralph/worker's-script.sh",
			sentinel: "test.sentinel",
			timeoutMs: 120_000,
			tailLines: 20,
			onLaunched: () => {
				launched = true;
			},
		});

		expect(result).toEqual({
			exited: true,
			exitCode: 7,
			tail: "tail\nRALPH_WORKER_EXIT issue=34 code=7 sentinel=test.sentinel\n",
		});
		expect(launched).toBe(true);
		expect(calls[0]?.args).toEqual(["pane", "run", "pane-1", "sh '/repo/.ralph/worker'\\''s-script.sh'"]);
		expect(calls[1]?.args).toEqual([
			"wait",
			"output",
			"pane-1",
			"--match",
			"sentinel=test.sentinel",
			"--timeout",
			"120000",
		]);
		expect(calls[2]?.args).toEqual(["pane", "read", "pane-1", "--source", "recent-unwrapped", "--lines", "20"]);
	});

	it("returns exited=false when the sentinel wait times out", async () => {
		const { pi } = createPi({ waitCode: 1 });
		const result = await runWorkerScriptInPane(pi as never, "/repo", {
			paneId: "pane-1",
			scriptPath: "/repo/.ralph/worker.sh",
			sentinel: "test.sentinel",
			timeoutMs: 120_000,
		});

		expect(result.exited).toBe(false);
		expect(result.exitCode).toBe(7);
	});

	it("parses worker exit codes from pane output", () => {
		expect(parseWorkerExitCode("RALPH_WORKER_EXIT issue=34 code=7 sentinel=a.b?c", "a.b?c")).toBe(7);
	});
});
