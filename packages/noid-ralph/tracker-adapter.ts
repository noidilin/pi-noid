import path from "node:path";
import { extractAcceptanceCriteria } from "./acceptance";
import type { FinalizeIssueResult } from "./github";
import { extractParentFromBody, parseIssueNumber } from "./github";
import type {
	ChildIssue,
	IssueMetadata,
	MattRalphStateV2,
	ResolvedImplementationTarget,
	ResolvedTargetPlan,
	TargetSourceKind,
} from "./types";

export type ResolveTargetPlanInput = {
	cwd: string;
	target: string;
};

export type TargetCompletion = {
	body?: string;
};

export type TargetFinalizationSummary = {
	succeeded: FinalizeIssueResult[];
	failed: FinalizeIssueResult[];
	skipped: string[];
	note: string;
};

export type TrackerAdapterDependencies = {
	targetExists(file: string): boolean;
	readTarget(file: string): Promise<string>;
	viewIssue(issue: number): Promise<IssueMetadata | undefined>;
	discoverChildren(parent: number): Promise<ChildIssue[]>;
	hasCommand(command: string): Promise<boolean>;
	finalizeIssue(issue: number, body?: string): Promise<FinalizeIssueResult>;
	now(): string;
};

export class TargetResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TargetResolutionError";
	}
}

export async function resolveTargetPlan(
	input: ResolveTargetPlanInput,
	dependencies: Pick<TrackerAdapterDependencies, "targetExists" | "readTarget" | "viewIssue" | "discoverChildren">,
): Promise<ResolvedTargetPlan> {
	const issueNumber = parseIssueNumber(input.target);
	if (issueNumber) return resolveGitHubPlan(issueNumber, dependencies);

	const absolutePath = path.resolve(input.cwd, input.target);
	const looksLikePath =
		dependencies.targetExists(absolutePath) || input.target.includes("/") || input.target.endsWith(".md");
	if (looksLikePath) {
		if (!dependencies.targetExists(absolutePath)) {
			throw new TargetResolutionError(`Target file not found: ${input.target}`);
		}
		const body = await dependencies.readTarget(absolutePath);
		const target: ResolvedImplementationTarget = {
			key: `prd:${input.target}`,
			source: "prd",
			title: input.target,
			body,
			acceptanceCriteria: extractAcceptanceCriteria({ body }),
		};
		return { root: target, targets: [target] };
	}

	const target: ResolvedImplementationTarget = {
		key: `text:${keyFragment(input.target)}`,
		source: "text",
		title: input.target,
		acceptanceCriteria: [],
	};
	return { root: target, targets: [target] };
}

export async function finalizeTargetPlan(
	plan: ResolvedTargetPlan,
	completion: TargetCompletion,
	dependencies: Pick<TrackerAdapterDependencies, "hasCommand" | "finalizeIssue" | "now">,
): Promise<TargetFinalizationSummary> {
	const issueNumbers = githubIssueNumbers(plan);
	if (issueNumbers.length === 0) {
		return skippedFinalization("No GitHub issue targets in this session.", dependencies.now());
	}
	if (!(await dependencies.hasCommand("gh"))) {
		return skippedFinalization("gh is not available; skipped final GitHub issue comment/close.", dependencies.now());
	}

	const results: FinalizeIssueResult[] = [];
	for (const issue of issueNumbers) results.push(await dependencies.finalizeIssue(issue, completion.body));
	const succeeded = results.filter((result) => result.commented && result.closed);
	const failed = results.filter((result) => !result.commented || !result.closed);
	return {
		succeeded,
		failed,
		skipped: [],
		note: finalizationNote(succeeded, failed, [], dependencies.now()),
	};
}

export function targetPlanFromV2State(state: MattRalphStateV2): ResolvedTargetPlan {
	const rootIssueNumber = parseIssueNumber(state.rootIssue);
	const source: TargetSourceKind = rootIssueNumber
		? "github"
		: state.rootIssue.includes("/") || state.rootIssue.endsWith(".md")
			? "prd"
			: "text";
	const root: ResolvedImplementationTarget = rootIssueNumber
		? {
				key: `github:${rootIssueNumber}`,
				source,
				title:
					state.childIssues.find((child) => child.number === rootIssueNumber)?.title ??
					`Issue #${rootIssueNumber}`,
				issueNumber: rootIssueNumber,
				...(state.parentIssue && state.parentIssue !== rootIssueNumber
					? { parentIssueNumber: state.parentIssue }
					: {}),
				acceptanceCriteria: [],
				acceptanceCriteriaResolved: false,
			}
		: {
				key: `${source}:${source === "text" ? keyFragment(state.rootIssue) : state.rootIssue}`,
				source,
				title: state.rootIssue,
				acceptanceCriteria: [],
				acceptanceCriteriaResolved: false,
			};
	const targets = state.childIssues.map((child): ResolvedImplementationTarget => {
		if (child.number <= 0) return { ...root, title: child.title };
		return {
			key: `github:${child.number}`,
			source: "github",
			title: child.title,
			issueNumber: child.number,
			...(state.parentIssue && state.parentIssue !== child.number ? { parentIssueNumber: state.parentIssue } : {}),
			...(child.state ? { state: child.state } : {}),
			issueSource: child.source,
			acceptanceCriteria: [],
			acceptanceCriteriaResolved: false,
		};
	});
	return { root, targets };
}

export function formatTargetFinalizationNotice(name: string, finalization: TargetFinalizationSummary): string {
	const pieces = [`Matt Ralph completed: ${name}`];
	if (finalization.succeeded.length > 0) {
		pieces.push(`commented/closed ${finalization.succeeded.map((result) => `#${result.issue}`).join(", ")}`);
	}
	if (finalization.failed.length > 0) {
		pieces.push(
			`GitHub finalization failed for ${finalization.failed.map((result) => `#${result.issue}`).join(", ")}`,
		);
	}
	if (finalization.skipped.length > 0) pieces.push(finalization.skipped.join(" "));
	return pieces.join("; ");
}

async function resolveGitHubPlan(
	issueNumber: number,
	dependencies: Pick<TrackerAdapterDependencies, "viewIssue" | "discoverChildren">,
): Promise<ResolvedTargetPlan> {
	const issue = await dependencies.viewIssue(issueNumber);
	const parentIssueNumber = issue?.parent?.number ?? extractParentFromBody(issue?.body);
	const root = githubTarget({
		number: issueNumber,
		title: issue?.title ?? `Issue #${issueNumber}`,
		body: issue?.body,
		state: issue?.state,
		parentIssueNumber,
	});
	if (parentIssueNumber) return { root, targets: [{ ...root, issueSource: "standalone" }] };

	const children = await dependencies.discoverChildren(issueNumber);
	if (children.length === 0) return { root, targets: [{ ...root, issueSource: "standalone" }] };
	const targets = await Promise.all(
		children.map(async (child) => {
			const resolved = await dependencies.viewIssue(child.number);
			return githubTarget({
				number: child.number,
				title: resolved?.title ?? child.title,
				body: resolved?.body,
				state: resolved?.state ?? child.state,
				parentIssueNumber: issueNumber,
				issueSource: child.source,
			});
		}),
	);
	return { root, targets };
}

function githubTarget(input: {
	number: number;
	title: string;
	body?: string;
	state?: "open" | "closed";
	parentIssueNumber?: number;
	issueSource?: ChildIssue["source"];
}): ResolvedImplementationTarget {
	return {
		key: `github:${input.number}`,
		source: "github",
		title: input.title,
		...(input.body === undefined ? {} : { body: input.body }),
		issueNumber: input.number,
		...(input.parentIssueNumber === undefined ? {} : { parentIssueNumber: input.parentIssueNumber }),
		...(input.state === undefined ? {} : { state: input.state }),
		...(input.issueSource === undefined ? {} : { issueSource: input.issueSource }),
		acceptanceCriteria: extractAcceptanceCriteria({ body: input.body }),
	};
}

function githubIssueNumbers(plan: ResolvedTargetPlan): number[] {
	const issues = plan.targets
		.filter((target) => target.source === "github")
		.map((target) => target.issueNumber)
		.filter((issue): issue is number => issue !== undefined);
	if (plan.root.source === "github" && plan.root.issueNumber !== undefined) issues.push(plan.root.issueNumber);
	return [...new Set(issues)];
}

function skippedFinalization(reason: string, now: string): TargetFinalizationSummary {
	return { succeeded: [], failed: [], skipped: [reason], note: finalizationNote([], [], [reason], now) };
}

function finalizationNote(
	succeeded: FinalizeIssueResult[],
	failed: FinalizeIssueResult[],
	skipped: string[],
	now: string,
): string {
	const lines = ["", "", "## GitHub finalization", "", `Completed at ${now}.`, ""];
	if (succeeded.length > 0) {
		lines.push("### Commented and closed", "", ...succeeded.map((result) => `- #${result.issue}`), "");
	}
	if (failed.length > 0) {
		lines.push(
			"### Failed",
			"",
			...failed.map(
				(result) =>
					`- #${result.issue}: commented=${result.commented}, closed=${result.closed}${result.error ? `, error=${result.error}` : ""}`,
			),
			"",
		);
	}
	if (skipped.length > 0) lines.push("### Skipped", "", ...skipped.map((reason) => `- ${reason}`), "");
	return lines.join("\n");
}

function keyFragment(input: string): string {
	return (
		input
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "target"
	);
}
