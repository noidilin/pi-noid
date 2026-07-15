import { describe, expect, it } from "vitest";
import {
	buildFinalPrompt,
	buildKickoffPrompt,
	buildNextPrompt,
	buildResumePrompt,
	buildSystemInjection,
	renderRalphPrompt,
} from "./prompt-template";
import type { MattRalphState } from "./types";

function createState(overrides: Partial<MattRalphState> = {}): MattRalphState {
	return {
		schemaVersion: 3,
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
		targetPlan: {
			root: { key: "github:34", source: "github", title: "Parent", issueNumber: 34, acceptanceCriteria: [] },
			targets: [
				{
					key: "github:35",
					source: "github",
					title: "First child",
					body: "## Acceptance Criteria\n\n- [ ] First behavior works",
					issueNumber: 35,
					parentIssueNumber: 34,
					state: "open",
					issueSource: "native",
					acceptanceCriteria: [{ id: "first-behavior-works", text: "First behavior works", source: "checklist" }],
				},
				{
					key: "github:36",
					source: "github",
					title: "Second child",
					issueNumber: 36,
					parentIssueNumber: 34,
					state: "closed",
					issueSource: "parent-section",
					acceptanceCriteria: [],
				},
			],
		},
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
		expect(buildKickoffPrompt(state).match(/First behavior works/g)).toHaveLength(1);
		expect(buildFinalPrompt(state)).toContain("First behavior works");
		expect(buildSystemInjection(state)).toContain("First behavior works");
	});

	it("characterizes criteria-free text targets and uncapped iterations", () => {
		const state = createState({
			rootIssue: "write characterization tests",
			parentIssue: undefined,
			childIssues: [{ number: 0, title: "write characterization tests", source: "standalone" }],
			targetPlan: {
				root: {
					key: "text:write-characterization-tests",
					source: "text",
					title: "write characterization tests",
					acceptanceCriteria: [],
				},
				targets: [
					{
						key: "text:write-characterization-tests",
						source: "text",
						title: "write characterization tests",
						acceptanceCriteria: [],
					},
				],
			},
			maxIterations: undefined,
			initialDirtyStatus: undefined,
		});

		expect(buildKickoffPrompt(state)).toMatchSnapshot();
		expect(buildKickoffPrompt(state)).toContain("No source acceptance criteria were found.");
	});

	it("renders unresolved migrated acceptance explicitly", () => {
		const state = createState();
		state.targetPlan.targets[0] = {
			...state.targetPlan.targets[0],
			acceptanceCriteria: [],
			acceptanceCriteriaResolved: false,
		};

		expect(buildResumePrompt(state)).toContain("Acceptance criteria are unresolved for this migrated session.");
	});

	it("rejects a context for the wrong named template", () => {
		expect(() =>
			renderRalphPrompt("implementation.kickoff", {
				kind: "final",
				sessionName: "wrong-context",
				notesPath: ".ralph/wrong.md",
			}),
		).toThrow("Invalid context for implementation.kickoff");
	});
});
