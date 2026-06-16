import { describe, expect, it } from "vitest";
import { buildOrchestratePlan } from "./orchestrate-planner";
import type { OrchestrateChild } from "./orchestrate-types";

const child = (
	number: number,
	body = "## Blocked by\nNone",
	order = number,
	state: "open" | "closed" = "open",
): OrchestrateChild => ({
	number,
	title: `Issue ${number}`,
	state,
	body,
	source: "native",
	order,
});

const parent = { number: 1, title: "Parent" };

describe("orchestrate planner", () => {
	it("skips closed child but satisfies dependency", async () => {
		const plan = await buildOrchestratePlan({
			parent,
			children: [child(2, "", 0, "closed"), child(3, "## Blocked by\n#2", 1)],
		});
		expect(plan.skippedClosed.map((issue) => issue.number)).toEqual([2]);
		expect(plan.plannedOrder.map((issue) => issue.number)).toEqual([3]);
		expect(plan.valid).toBe(true);
	});

	it("orders open sibling dependencies correctly", async () => {
		const plan = await buildOrchestratePlan({
			parent,
			children: [child(3, "## Blocked by\n#2", 0), child(2, "", 1)],
		});
		expect(plan.plannedOrder.map((issue) => issue.number)).toEqual([2, 3]);
	});

	it("preserves GitHub order for independent issues", async () => {
		const plan = await buildOrchestratePlan({ parent, children: [child(5, "", 0), child(2, "", 1)] });
		expect(plan.plannedOrder.map((issue) => issue.number)).toEqual([5, 2]);
	});

	it("falls back to issue-number ordering when order ties", async () => {
		const plan = await buildOrchestratePlan({ parent, children: [child(5, "", 0), child(2, "", 0)] });
		expect(plan.plannedOrder.map((issue) => issue.number)).toEqual([2, 5]);
	});

	it("satisfies closed external dependency", async () => {
		const plan = await buildOrchestratePlan({
			parent,
			children: [child(2, "## Blocked by\n#99")],
			resolveExternalIssue: async () => ({ state: "closed" }),
		});
		expect(plan.valid).toBe(true);
		expect(plan.blockers).toEqual([]);
	});

	it("blocks on open external dependency", async () => {
		const plan = await buildOrchestratePlan({
			parent,
			children: [child(2, "## Blocked by\n#99")],
			resolveExternalIssue: async () => ({ state: "open" }),
		});
		expect(plan.valid).toBe(false);
		expect(plan.blockers[0]).toMatchObject({ issue: 99, scope: "external", status: "blocking" });
	});

	it("blocks unresolved path dependency", async () => {
		const plan = await buildOrchestratePlan({
			parent,
			children: [child(2, "## Blocked by\ndocs/issues/missing.md")],
		});
		expect(plan.valid).toBe(false);
		expect(plan.blockers[0]).toMatchObject({ path: "docs/issues/missing.md", scope: "unresolved" });
	});

	it("detects cycles", async () => {
		const plan = await buildOrchestratePlan({
			parent,
			children: [child(2, "## Blocked by\n#3"), child(3, "## Blocked by\n#2")],
		});
		expect(plan.valid).toBe(false);
		expect(plan.cycles.length).toBeGreaterThan(0);
	});

	it("orders a diamond dependency graph", async () => {
		const plan = await buildOrchestratePlan({
			parent,
			children: [
				child(4, "## Blocked by\n#2\n#3", 0),
				child(2, "## Blocked by\n#1", 1),
				child(3, "## Blocked by\n#1", 2),
				child(1, "", 3),
			],
		});
		expect(plan.plannedOrder.map((issue) => issue.number)).toEqual([1, 2, 3, 4]);
	});
});
