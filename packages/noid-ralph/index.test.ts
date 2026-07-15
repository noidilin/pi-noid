import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import mattRalphExtension, { hasGitCommit, protectRalphGitCommitCommand } from "./index";
import { setActiveSession, writeState } from "./loop-store";
import type { MattRalphState } from "./types";

async function tempRepo(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "ralph-index-"));
}

function createState(overrides: Partial<MattRalphState> = {}): MattRalphState {
	return {
		schemaVersion: 2,
		name: "implement-issue-34",
		taskFile: ".ralph/implement-issue-34.md",
		status: "active",
		mode: "implement",
		rootIssue: "#34",
		parentIssue: 34,
		childIssues: [
			{ number: 35, title: "First child", source: "native", state: "open" },
			{ number: 36, title: "Second child", source: "parent-section", state: "open" },
		],
		currentIndex: 0,
		iteration: 2,
		maxIterations: 4,
		startedAt: "2026-01-01T00:00:00.000Z",
		warnings: ["gh unavailable"],
		initialDirtyStatus: " M src/existing.ts",
		...overrides,
	};
}

describe("Ralph git commit protection", () => {
	it("detects and wraps git commit commands", () => {
		const command = 'git add . && git commit -m "work"';
		const protectedCommand = protectRalphGitCommitCommand(command);

		expect(hasGitCommit(command)).toBe(true);
		expect(protectedCommand).toBe(
			'git add . && { git restore --staged -- .ralph 2>/dev/null || true; git rm --cached -r --ignore-unmatch .ralph 2>/dev/null || true; } && git commit -m "work"',
		);
	});

	it("leaves non-commit git commands unchanged", () => {
		const command = "git status --short";
		expect(hasGitCommit(command)).toBe(false);
		expect(protectRalphGitCommitCommand(command)).toBe(command);
	});
});

describe("Ralph UI projection", () => {
	it("projects active schema-v2 state into the status line and compact widget", async () => {
		const cwd = await tempRepo();
		const state = createState();
		await writeState(cwd, state);
		await setActiveSession(cwd, state.name);
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
		const pi = {
			registerCommand() {},
			registerTool() {},
			on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
				handlers.set(name, handler);
			},
			events: { emit() {} },
		};
		mattRalphExtension(pi as never);
		const statuses: unknown[][] = [];
		let widgetFactory:
			| ((tui: unknown, theme: { fg(color: string, text: string): string }) => { render(width: number): string[] })
			| undefined;
		const ctx = {
			cwd,
			ui: {
				setStatus: (...args: unknown[]) => statuses.push(args),
				setWidget: (_key: string, widget: typeof widgetFactory) => {
					widgetFactory = widget;
				},
			},
		};

		await handlers.get("session_start")?.({}, ctx);

		expect(statuses).toEqual([["matt-ralph", "matt ● 1/2 i2/4"]]);
		const widget = widgetFactory?.({}, { fg: (_color, text) => text });
		expect(widget?.render(50)).toMatchSnapshot();
	});
});
