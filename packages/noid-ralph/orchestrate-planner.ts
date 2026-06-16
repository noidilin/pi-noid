import { parseBlockedByDependencies } from "./dependency-parser";
import type { DependencyRef, OrchestrateChild, OrchestratePlan, ResolveExternalIssue } from "./orchestrate-types";

export async function buildOrchestratePlan(options: {
	parent: { number: number; title: string; url?: string };
	children: OrchestrateChild[];
	resolveExternalIssue?: ResolveExternalIssue;
}): Promise<OrchestratePlan> {
	const allChildren = options.children.map((child, index) => ({ ...child, order: child.order ?? index }));
	const openChildren = allChildren.filter((child) => child.state !== "closed");
	const skippedClosed = allChildren.filter((child) => child.state === "closed");
	const byIssue = new Map(allChildren.map((child) => [child.number, child]));
	const pathMap = buildPathMap(allChildren);
	const dependenciesByIssue: Record<number, DependencyRef[]> = {};
	const blockers: DependencyRef[] = [];
	const edges = new Map<number, Set<number>>();
	const indegree = new Map<number, number>();
	for (const child of openChildren) {
		edges.set(child.number, new Set());
		indegree.set(child.number, 0);
	}

	for (const child of openChildren) {
		const deps: DependencyRef[] = [];
		for (const parsed of parseBlockedByDependencies(child.body)) {
			let dep: DependencyRef;
			if (parsed.kind === "unresolved") {
				dep = { raw: parsed.raw, scope: "unresolved", status: "blocking", reason: parsed.reason };
			} else if (parsed.kind === "path") {
				const resolvedIssue = pathMap.get(parsed.path);
				if (resolvedIssue)
					dep = await resolveIssueRef(
						parsed.raw,
						resolvedIssue,
						child.number,
						byIssue,
						options.resolveExternalIssue,
					);
				else
					dep = {
						raw: parsed.raw,
						path: parsed.path,
						scope: "unresolved",
						status: "blocking",
						reason: "Path dependency could not be mapped to a child issue.",
					};
			} else {
				dep = await resolveIssueRef(parsed.raw, parsed.issue, child.number, byIssue, options.resolveExternalIssue);
			}
			deps.push(dep);
			if (dep.status === "blocking" && dep.scope !== "sibling") blockers.push(dep);
			if (dep.scope === "sibling" && dep.status === "blocking" && dep.resolvedIssue) {
				edges.get(dep.resolvedIssue)?.add(child.number);
				indegree.set(child.number, (indegree.get(child.number) ?? 0) + 1);
			}
		}
		dependenciesByIssue[child.number] = deps;
	}

	const cycles = findCycles(
		openChildren.map((child) => child.number),
		edges,
	);
	const plannedOrder = blockers.length === 0 && cycles.length === 0 ? topoSort(openChildren, edges, indegree) : [];
	return {
		parent: options.parent,
		allChildren,
		openChildren,
		skippedClosed,
		dependenciesByIssue,
		plannedOrder,
		blockers,
		cycles,
		valid: blockers.length === 0 && cycles.length === 0,
	};
}

async function resolveIssueRef(
	raw: string,
	issue: number,
	blockedIssue: number,
	byIssue: Map<number, OrchestrateChild>,
	resolveExternalIssue?: ResolveExternalIssue,
): Promise<DependencyRef> {
	const sibling = byIssue.get(issue);
	if (sibling) {
		return {
			raw,
			issue,
			resolvedIssue: issue,
			scope: "sibling",
			status: sibling.state === "closed" || issue === blockedIssue ? "satisfied" : "blocking",
			reason: sibling.state === "closed" ? "Closed sibling dependency is satisfied." : undefined,
		};
	}
	const external = await resolveExternalIssue?.(issue);
	if (external?.state === "closed") {
		return {
			raw,
			issue,
			resolvedIssue: issue,
			scope: "external",
			status: "satisfied",
			reason: "External issue is closed.",
		};
	}
	return {
		raw,
		issue,
		resolvedIssue: external ? issue : undefined,
		scope: "external",
		status: "blocking",
		reason: external?.state === "open" ? "External issue is open." : "External issue could not be resolved.",
	};
}

function buildPathMap(children: OrchestrateChild[]): Map<string, number> {
	const map = new Map<string, number>();
	for (const child of children) {
		const haystack = [bodyWithoutBlockedBy(child.body), child.url, child.title].filter(Boolean).join("\n");
		for (const match of haystack.matchAll(/(?:\.\/)?[\w./-]+\.md/g)) {
			const normalized = normalizePath(match[0]);
			if (!map.has(normalized)) map.set(normalized, child.number);
		}
	}
	return map;
}

function normalizePath(value: string): string {
	return value.replace(/^\.\//, "");
}

function bodyWithoutBlockedBy(body: string | undefined): string | undefined {
	if (!body) return undefined;
	const lines = body.split(/\r?\n/);
	const kept: string[] = [];
	let skipping = false;
	for (const line of lines) {
		if (/^##\s+Blocked by\s*$/i.test(line.trim())) {
			skipping = true;
			continue;
		}
		if (skipping && /^#{1,2}\s+/.test(line.trim())) skipping = false;
		if (!skipping) kept.push(line);
	}
	return kept.join("\n");
}

function topoSort(
	children: OrchestrateChild[],
	edges: Map<number, Set<number>>,
	indegree: Map<number, number>,
): OrchestrateChild[] {
	const byIssue = new Map(children.map((child) => [child.number, child]));
	const ready = children.filter((child) => (indegree.get(child.number) ?? 0) === 0).sort(compareChild);
	const result: OrchestrateChild[] = [];
	while (ready.length > 0) {
		const child = ready.shift();
		if (!child) break;
		result.push(child);
		for (const next of edges.get(child.number) ?? []) {
			indegree.set(next, (indegree.get(next) ?? 0) - 1);
			if ((indegree.get(next) ?? 0) === 0) {
				const nextChild = byIssue.get(next);
				if (nextChild) ready.push(nextChild);
				ready.sort(compareChild);
			}
		}
	}
	return result.length === children.length ? result : [];
}

function findCycles(nodes: number[], edges: Map<number, Set<number>>): number[][] {
	const cycles: number[][] = [];
	const visiting = new Set<number>();
	const visited = new Set<number>();
	const stack: number[] = [];
	const visit = (node: number) => {
		if (visiting.has(node)) {
			const start = stack.indexOf(node);
			if (start >= 0) cycles.push([...stack.slice(start), node]);
			return;
		}
		if (visited.has(node)) return;
		visiting.add(node);
		stack.push(node);
		for (const next of edges.get(node) ?? []) visit(next);
		stack.pop();
		visiting.delete(node);
		visited.add(node);
	};
	for (const node of nodes) visit(node);
	return cycles;
}

function compareChild(a: OrchestrateChild, b: OrchestrateChild): number {
	return a.order - b.order || a.number - b.number;
}
