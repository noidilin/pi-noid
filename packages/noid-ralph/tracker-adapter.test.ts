import { describe, expect, it } from "vitest";
import {
	finalizeTargetPlan,
	resolveTargetPlan,
	TargetResolutionError,
	type TrackerAdapterDependencies,
	targetPlanFromV2State,
} from "./tracker-adapter";
import type { MattRalphState } from "./types";

function createDependencies(overrides: Partial<TrackerAdapterDependencies> = {}): TrackerAdapterDependencies {
	return {
		targetExists: () => false,
		readTarget: async () => "",
		viewIssue: async (issue) => ({ number: issue, title: `Issue ${issue}`, state: "open" }),
		discoverChildren: async () => [],
		hasCommand: async () => true,
		finalizeIssue: async (issue) => ({ issue, commented: true, closed: true }),
		now: () => "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("target tracker adapter", () => {
	it("normalizes a GitHub parent and its discovered children", async () => {
		const plan = await resolveTargetPlan(
			{ cwd: "/repo", target: "#34" },
			createDependencies({
				viewIssue: async (issue) =>
					issue === 34
						? { number: 34, title: "Parent", body: "Parent body", state: "open" }
						: { number: issue, title: `Resolved child ${issue}`, body: `Child ${issue} body`, state: "open" },
				discoverChildren: async () => [
					{ number: 35, title: "First child", state: "open", source: "native" },
					{ number: 36, title: "Second child", state: "closed", source: "parent-section" },
				],
			}),
		);

		expect(plan).toEqual({
			root: {
				key: "github:34",
				source: "github",
				title: "Parent",
				body: "Parent body",
				issueNumber: 34,
				state: "open",
				acceptanceCriteria: [],
			},
			targets: [
				{
					key: "github:35",
					source: "github",
					title: "Resolved child 35",
					body: "Child 35 body",
					issueNumber: 35,
					parentIssueNumber: 34,
					state: "open",
					issueSource: "native",
					acceptanceCriteria: [],
				},
				{
					key: "github:36",
					source: "github",
					title: "Resolved child 36",
					body: "Child 36 body",
					issueNumber: 36,
					parentIssueNumber: 34,
					state: "open",
					issueSource: "parent-section",
					acceptanceCriteria: [],
				},
			],
		});
	});

	it("normalizes a targeted GitHub child without rediscovering siblings", async () => {
		let discovered = false;
		const plan = await resolveTargetPlan(
			{ cwd: "/repo", target: "#35" },
			createDependencies({
				viewIssue: async () => ({
					number: 35,
					title: "Child",
					body: "Child body",
					state: "open",
					parent: { number: 34, title: "Parent" },
				}),
				discoverChildren: async () => {
					discovered = true;
					return [];
				},
			}),
		);

		expect(discovered).toBe(false);
		expect(plan.root).toMatchObject({ key: "github:35", issueNumber: 35, parentIssueNumber: 34 });
		expect(plan.targets).toEqual([
			expect.objectContaining({ key: "github:35", issueNumber: 35, parentIssueNumber: 34, body: "Child body" }),
		]);
	});

	it("normalizes a standalone GitHub issue as one target", async () => {
		const plan = await resolveTargetPlan(
			{ cwd: "/repo", target: "https://github.com/acme/repo/issues/37" },
			createDependencies({
				viewIssue: async () => ({ number: 37, title: "Standalone", body: "Issue body", state: "open" }),
			}),
		);

		expect(plan).toEqual({
			root: {
				key: "github:37",
				source: "github",
				title: "Standalone",
				body: "Issue body",
				issueNumber: 37,
				state: "open",
				acceptanceCriteria: [],
			},
			targets: [
				{
					key: "github:37",
					source: "github",
					title: "Standalone",
					body: "Issue body",
					issueNumber: 37,
					state: "open",
					issueSource: "standalone",
					acceptanceCriteria: [],
				},
			],
		});
	});

	it("normalizes local Markdown and free-text targets", async () => {
		const dependencies = createDependencies({
			targetExists: (file) => file === "/repo/docs/plan.md",
			readTarget: async () => "# Local plan\n",
		});

		await expect(resolveTargetPlan({ cwd: "/repo", target: "docs/plan.md" }, dependencies)).resolves.toEqual({
			root: {
				key: "prd:docs/plan.md",
				source: "prd",
				title: "docs/plan.md",
				body: "# Local plan\n",
				acceptanceCriteria: [],
			},
			targets: [
				{
					key: "prd:docs/plan.md",
					source: "prd",
					title: "docs/plan.md",
					body: "# Local plan\n",
					acceptanceCriteria: [],
				},
			],
		});
		await expect(resolveTargetPlan({ cwd: "/repo", target: "write tests" }, dependencies)).resolves.toEqual({
			root: { key: "text:write-tests", source: "text", title: "write tests", acceptanceCriteria: [] },
			targets: [{ key: "text:write-tests", source: "text", title: "write tests", acceptanceCriteria: [] }],
		});
		await expect(resolveTargetPlan({ cwd: "/repo", target: "docs/missing.md" }, dependencies)).rejects.toEqual(
			new TargetResolutionError("Target file not found: docs/missing.md"),
		);
	});

	it("finalizes GitHub targets and a distinct GitHub root exactly once", async () => {
		const finalized: number[] = [];
		const plan = await resolveTargetPlan(
			{ cwd: "/repo", target: "#34" },
			createDependencies({
				discoverChildren: async () => [
					{ number: 35, title: "First", source: "native" },
					{ number: 36, title: "Second", source: "native" },
				],
			}),
		);
		const result = await finalizeTargetPlan(
			plan,
			{ body: "Final verification" },
			createDependencies({
				finalizeIssue: async (issue) => {
					finalized.push(issue);
					return { issue, commented: true, closed: true };
				},
			}),
		);

		expect(finalized).toEqual([35, 36, 34]);
		expect(result.succeeded.map(({ issue }) => issue)).toEqual([35, 36, 34]);
		expect(result.note).toContain("## GitHub finalization");
	});

	it("finalizes only the targeted child when its parent is context", async () => {
		const finalized: number[] = [];
		const plan = await resolveTargetPlan(
			{ cwd: "/repo", target: "#35" },
			createDependencies({
				viewIssue: async () => ({
					number: 35,
					title: "Child",
					parent: { number: 34, title: "Parent" },
				}),
			}),
		);

		await finalizeTargetPlan(
			plan,
			{},
			createDependencies({
				finalizeIssue: async (issue) => {
					finalized.push(issue);
					return { issue, commented: true, closed: true };
				},
			}),
		);

		expect(finalized).toEqual([35]);
	});

	it("skips GitHub finalization when gh is unavailable", async () => {
		const plan = await resolveTargetPlan({ cwd: "/repo", target: "#37" }, createDependencies());
		const result = await finalizeTargetPlan(plan, {}, createDependencies({ hasCommand: async () => false }));

		expect(result).toMatchObject({
			succeeded: [],
			failed: [],
			skipped: ["gh is not available; skipped final GitHub issue comment/close."],
		});
	});

	it("uses explicit no-op finalization for non-GitHub plans", async () => {
		const plan = await resolveTargetPlan({ cwd: "/repo", target: "write tests" }, createDependencies());
		const result = await finalizeTargetPlan(plan, {}, createDependencies());

		expect(result).toMatchObject({
			succeeded: [],
			failed: [],
			skipped: ["No GitHub issue targets in this session."],
		});
	});

	it("reconstructs a normalized plan from schema-v2 state for resume and completion", () => {
		const state = {
			schemaVersion: 2,
			name: "implement-issue-34",
			taskFile: ".ralph/implement-issue-34.md",
			status: "active",
			mode: "implement",
			rootIssue: "#34",
			parentIssue: 34,
			childIssues: [{ number: 35, title: "Child", source: "native", state: "open" }],
			currentIndex: 0,
			iteration: 1,
			startedAt: "2026-01-01T00:00:00.000Z",
		} satisfies MattRalphState;

		expect(targetPlanFromV2State(state)).toEqual({
			root: {
				key: "github:34",
				source: "github",
				title: "Issue #34",
				issueNumber: 34,
				acceptanceCriteria: [],
			},
			targets: [
				{
					key: "github:35",
					source: "github",
					title: "Child",
					issueNumber: 35,
					parentIssueNumber: 34,
					state: "open",
					issueSource: "native",
					acceptanceCriteria: [],
				},
			],
		});
	});
});
