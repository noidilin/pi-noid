import { describe, expect, it } from "vitest";
import {
	buildFinalPrompt,
	buildKickoffPrompt,
	buildNextPrompt,
	buildResumePrompt,
	buildSystemInjection,
} from "./prompt";
import type { MattRalphState } from "./types";

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
			{ number: 36, title: "Second child", source: "parent-section", state: "closed" },
		],
		currentIndex: 0,
		iteration: 1,
		startedAt: "2026-01-01T00:00:00.000Z",
		maxIterations: 4,
		initialDirtyStatus: " M src/existing.ts",
		...overrides,
	};
}

describe("Ralph prompts", () => {
	it("characterizes every implementation prompt phase", () => {
		const state = createState();

		expect(buildKickoffPrompt(state)).toMatchSnapshot("kickoff");
		expect(buildResumePrompt(state)).toMatchSnapshot("resume");
		expect(buildNextPrompt({ ...state, currentIndex: 1, iteration: 2 })).toMatchSnapshot("next");
		expect(buildFinalPrompt({ ...state, currentIndex: 2, iteration: 3 })).toMatchSnapshot("final verification");
		expect(buildSystemInjection(state)).toMatchSnapshot("system injection");
	});

	it("characterizes criteria-free text targets and uncapped iterations", () => {
		const state = createState({
			rootIssue: "write characterization tests",
			parentIssue: undefined,
			childIssues: [{ number: 0, title: "write characterization tests", source: "standalone" }],
			maxIterations: undefined,
			initialDirtyStatus: undefined,
		});

		expect(buildKickoffPrompt(state)).toMatchSnapshot();
	});
});
