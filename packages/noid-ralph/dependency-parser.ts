export type ParsedDependencyRef =
	| { kind: "issue"; issue: number; raw: string }
	| { kind: "path"; path: string; raw: string }
	| { kind: "unresolved"; raw: string; reason: string };

export function extractBlockedBySection(body: string | undefined): string | undefined {
	if (!body) return undefined;
	const lines = body.split(/\r?\n/);
	const start = lines.findIndex((line) => /^##\s+Blocked by\s*$/i.test(line.trim()));
	if (start < 0) return undefined;
	const section: string[] = [];
	for (let index = start + 1; index < lines.length; index += 1) {
		if (/^#{1,2}\s+/.test(lines[index]?.trim() ?? "")) break;
		section.push(lines[index] ?? "");
	}
	return section.join("\n");
}

export function parseBlockedByDependencies(body: string | undefined): ParsedDependencyRef[] {
	const section = extractBlockedBySection(body);
	if (section === undefined) return [];
	const refs: ParsedDependencyRef[] = [];
	for (const rawLine of section.split(/\r?\n/)) {
		const raw = rawLine.trim();
		if (!raw) continue;
		const item = raw.replace(/^[-*+]\s+/, "").trim();
		if (!item) continue;
		if (/^`?none\b/i.test(item)) continue;

		const issueMatches = [
			...item.matchAll(/(?:^|[\s([`])#(\d+)\b/g),
			...item.matchAll(/https?:\/\/github\.com\/[^\s)]+\/[^\s)]+\/issues\/(\d+)\b/g),
		];
		if (issueMatches.length > 0) {
			for (const match of issueMatches) refs.push({ kind: "issue", issue: Number(match[1]), raw });
			continue;
		}

		const markdownPath = item.match(/\[[^\]]+\]\(([^)]+\.md)\)/i);
		if (markdownPath) {
			refs.push({ kind: "path", path: markdownPath[1] ?? "", raw });
			continue;
		}

		const backtickedPath = item.match(/`([^`]+\.md)`/i);
		if (backtickedPath) {
			refs.push({ kind: "path", path: backtickedPath[1] ?? "", raw });
			continue;
		}

		if (/^[`]?\d+[`]?$/.test(item)) {
			refs.push({ kind: "issue", issue: Number(item.replace(/`/g, "")), raw });
			continue;
		}

		const plainPath = item.match(/^(?:\.\/)?[^\s]+\.md$/i);
		if (plainPath) {
			refs.push({ kind: "path", path: item.replace(/^\.\//, ""), raw });
			continue;
		}

		refs.push({ kind: "unresolved", raw, reason: "Could not parse dependency item." });
	}
	return refs;
}
