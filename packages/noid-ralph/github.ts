import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OrchestrateChild } from "./orchestrate-types";
import type { ChildIssue, IssueMetadata } from "./types";

export function parseIssueNumber(input: string): number | undefined {
	const trimmed = input.trim();
	const direct = trimmed.match(/^#?(\d+)$/);
	if (direct) return Number(direct[1]);
	const url = trimmed.match(/\/issues\/(\d+)(?:\b|$)/);
	if (url) return Number(url[1]);
	return undefined;
}

export async function hasCommand(pi: ExtensionAPI, command: string, cwd: string): Promise<boolean> {
	const result = await pi.exec("sh", ["-lc", `command -v ${command}`], { cwd, timeout: 5_000 });
	return result.code === 0;
}

export async function isGitRepo(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5_000 });
	return result.code === 0;
}

export async function dirtyStatus(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["status", "--porcelain"], { cwd, timeout: 5_000 });
	return result.code === 0 ? result.stdout.trim() : "";
}

export async function dirtyStatusExcludingRalph(pi: ExtensionAPI, cwd: string): Promise<string> {
	const status = await dirtyStatus(pi, cwd);
	return status
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line && !line.slice(3).startsWith(".ralph/"))
		.join("\n");
}

export async function resolveGitHubRepo(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const gh = await pi.exec("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
		cwd,
		timeout: 10_000,
	});
	if (gh.code === 0 && gh.stdout.trim()) return gh.stdout.trim();

	const remotes = await pi.exec("git", ["remote", "-v"], { cwd, timeout: 5_000 });
	if (remotes.code !== 0) return undefined;
	for (const line of remotes.stdout.split("\n")) {
		const remoteUrl = line.trim().split(/\s+/)[1];
		if (!remoteUrl) continue;
		const ssh = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
		if (ssh) return ssh[1];
		const https = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
		if (https) return https[1];
	}
	return undefined;
}

export async function viewIssue(pi: ExtensionAPI, cwd: string, issue: number): Promise<IssueMetadata | undefined> {
	const result = await pi.exec(
		"gh",
		["issue", "view", String(issue), "--json", "number,title,state,body,url,parent"],
		{
			cwd,
			timeout: 10_000,
		},
	);
	if (result.code !== 0) return undefined;
	try {
		const parsed = JSON.parse(result.stdout) as IssueMetadata;
		return normalizeIssue(parsed);
	} catch {
		return undefined;
	}
}

export type FinalizeIssueResult = {
	issue: number;
	commented: boolean;
	closed: boolean;
	error?: string;
};

export async function finalizeIssue(
	pi: ExtensionAPI,
	cwd: string,
	issue: number,
	body = "Final verification",
): Promise<FinalizeIssueResult> {
	const comment = await pi.exec("gh", ["issue", "comment", String(issue), "--body", body], {
		cwd,
		timeout: 15_000,
	});
	if (comment.code !== 0) {
		return { issue, commented: false, closed: false, error: formatGhError(comment.stderr || comment.stdout) };
	}

	const close = await pi.exec("gh", ["issue", "close", String(issue)], { cwd, timeout: 15_000 });
	if (close.code !== 0) {
		return { issue, commented: true, closed: false, error: formatGhError(close.stderr || close.stdout) };
	}

	return { issue, commented: true, closed: true };
}

export async function discoverChildren(pi: ExtensionAPI, cwd: string, parent: number): Promise<ChildIssue[]> {
	const native = await discoverNativeSubIssues(pi, cwd, parent);
	if (native.length > 0) return native;
	return discoverParentSectionChildren(pi, cwd, parent);
}

export async function discoverChildIssuesWithBodies(
	pi: ExtensionAPI,
	cwd: string,
	parent: number,
): Promise<OrchestrateChild[]> {
	const children = await discoverChildren(pi, cwd, parent);
	const full: OrchestrateChild[] = [];
	for (const [index, child] of children.entries()) {
		const issue = await viewIssue(pi, cwd, child.number);
		full.push({
			number: child.number,
			title: issue?.title ?? child.title,
			state: issue?.state ?? child.state,
			body: issue?.body,
			url: issue?.url,
			source: child.source,
			order: index,
		});
	}
	return full;
}

export async function finalizeParentIssue(
	pi: ExtensionAPI,
	cwd: string,
	parent: number,
	body: string,
): Promise<FinalizeIssueResult> {
	return finalizeIssue(pi, cwd, parent, body);
}

export async function isIssueClosed(pi: ExtensionAPI, cwd: string, issue: number): Promise<boolean> {
	return (await viewIssue(pi, cwd, issue))?.state === "closed";
}

async function discoverNativeSubIssues(pi: ExtensionAPI, cwd: string, parent: number): Promise<ChildIssue[]> {
	const result = await pi.exec("gh", ["issue", "view", String(parent), "--json", "subIssues"], {
		cwd,
		timeout: 10_000,
	});
	if (result.code !== 0) return [];
	try {
		const parsed = JSON.parse(result.stdout) as {
			subIssues?:
				| Array<{ number: number; title: string; state?: string }>
				| { nodes?: Array<{ number: number; title: string; state?: string }> };
		};
		const subIssues = Array.isArray(parsed.subIssues) ? parsed.subIssues : (parsed.subIssues?.nodes ?? []);
		return subIssues.map((issue) => ({
			number: issue.number,
			title: issue.title,
			state: normalizeState(issue.state),
			source: "native" as const,
		}));
	} catch {
		return [];
	}
}

async function discoverParentSectionChildren(pi: ExtensionAPI, cwd: string, parent: number): Promise<ChildIssue[]> {
	const result = await pi.exec(
		"gh",
		["issue", "list", "--state", "all", "--limit", "200", "--json", "number,title,state,body"],
		{ cwd, timeout: 15_000 },
	);
	if (result.code !== 0) return [];
	try {
		const issues = JSON.parse(result.stdout) as Array<{
			number: number;
			title: string;
			state?: string;
			body?: string;
		}>;
		return issues
			.filter((issue) => issue.number !== parent && hasParentSection(issue.body ?? "", parent))
			.map((issue) => ({
				number: issue.number,
				title: issue.title,
				state: normalizeState(issue.state),
				source: "parent-section" as const,
			}));
	} catch {
		return [];
	}
}

export function extractParentFromBody(body: string | undefined): number | undefined {
	const section = extractMarkdownSection(body, "Parent");
	if (!section) return undefined;
	const issueRef = section.match(/#(\d+)\b/);
	if (issueRef) return Number(issueRef[1]);
	const issueUrl = section.match(/\/issues\/(\d+)\b/);
	return issueUrl ? Number(issueUrl[1]) : undefined;
}

function extractMarkdownSection(body: string | undefined, heading: string): string | undefined {
	if (!body) return undefined;
	const lines = body.split(/\r?\n/);
	const start = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(line.trim()));
	if (start < 0) return undefined;
	const section: string[] = [];
	for (let index = start + 1; index < lines.length; index += 1) {
		if (/^#{1,2}\s+/.test(lines[index]?.trim() ?? "")) break;
		section.push(lines[index] ?? "");
	}
	return section.join("\n");
}

function hasParentSection(body: string, parent: number): boolean {
	const found = extractParentFromBody(body);
	return found === parent;
}

function formatGhError(output: string): string {
	return output.trim() || "gh command failed";
}

function normalizeIssue(issue: IssueMetadata): IssueMetadata {
	return {
		...issue,
		state: normalizeState(issue.state),
		parent: issue.parent ? { ...issue.parent, state: normalizeState(issue.parent.state) } : undefined,
	};
}

function normalizeState(state: string | undefined): "open" | "closed" | undefined {
	const lower = state?.toLowerCase();
	if (lower === "open" || lower === "closed") return lower;
	return undefined;
}
