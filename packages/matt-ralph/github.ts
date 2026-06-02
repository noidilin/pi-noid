import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
	const result = await pi.exec("gh", ["issue", "view", String(issue), "--json", "number,title,state,body,url"], {
		cwd,
		timeout: 10_000,
	});
	if (result.code !== 0) return undefined;
	try {
		const parsed = JSON.parse(result.stdout) as IssueMetadata;
		return normalizeIssue(parsed);
	} catch {
		return undefined;
	}
}

export async function discoverChildren(pi: ExtensionAPI, cwd: string, parent: number): Promise<ChildIssue[]> {
	const native = await discoverNativeSubIssues(pi, cwd, parent);
	if (native.length > 0) return native;
	return discoverParentSectionChildren(pi, cwd, parent);
}

async function discoverNativeSubIssues(pi: ExtensionAPI, cwd: string, parent: number): Promise<ChildIssue[]> {
	const result = await pi.exec("gh", ["issue", "view", String(parent), "--json", "subIssues"], {
		cwd,
		timeout: 10_000,
	});
	if (result.code !== 0) return [];
	try {
		const parsed = JSON.parse(result.stdout) as {
			subIssues?: Array<{ number: number; title: string; state?: string }>;
		};
		return (parsed.subIssues ?? []).map((issue) => ({
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
	if (!body) return undefined;
	const match = body.match(/##\s*Parent[\s\S]*?#(\d+)/i);
	return match ? Number(match[1]) : undefined;
}

function hasParentSection(body: string, parent: number): boolean {
	const found = extractParentFromBody(body);
	return found === parent;
}

function normalizeIssue(issue: IssueMetadata): IssueMetadata {
	return { ...issue, state: normalizeState(issue.state) };
}

function normalizeState(state: string | undefined): "open" | "closed" | undefined {
	const lower = state?.toLowerCase();
	if (lower === "open" || lower === "closed") return lower;
	return undefined;
}
