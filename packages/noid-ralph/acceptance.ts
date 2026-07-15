import type { AcceptanceCriterion } from "./types";

export type AcceptanceCriteriaInput = {
	structured?: readonly string[];
	body?: string;
};

export function extractAcceptanceCriteria(input: AcceptanceCriteriaInput): AcceptanceCriterion[] {
	if (input.structured?.length) return uniqueCriteria(input.structured, "structured");
	if (!input.body) return [];

	const sectionLines = acceptanceSectionLines(input.body);
	if (sectionLines) {
		const checklist = checklistItems(sectionLines);
		if (checklist.length > 0) return uniqueCriteria(checklist, "checklist");
		return uniqueCriteria(sectionItems(sectionLines), "section");
	}
	return uniqueCriteria(checklistItems(input.body.split(/\r?\n/)), "checklist");
}

function acceptanceSectionLines(body: string): string[] | undefined {
	const lines = body.split(/\r?\n/);
	const selected: string[] = [];
	let found = false;
	let acceptanceLevel: number | undefined;
	for (const line of lines) {
		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
		if (heading) {
			const level = heading[1].length;
			const title = heading[2].trim();
			if (/^acceptance criteria$/i.test(title)) {
				found = true;
				acceptanceLevel = level;
				continue;
			}
			if (acceptanceLevel !== undefined && level <= acceptanceLevel) acceptanceLevel = undefined;
		}
		if (acceptanceLevel !== undefined) selected.push(line);
	}
	return found ? selected : undefined;
}

function checklistItems(lines: readonly string[]): string[] {
	return lines.flatMap((line) => {
		const match = /^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/.exec(line);
		return match ? [match[1]] : [];
	});
}

function sectionItems(lines: readonly string[]): string[] {
	return lines.flatMap((line) => {
		const trimmed = line.trim();
		if (!trimmed || /^#{1,6}\s+/.test(trimmed)) return [];
		return [trimmed.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "")];
	});
}

function uniqueCriteria(values: readonly string[], source: AcceptanceCriterion["source"]): AcceptanceCriterion[] {
	const seen = new Set<string>();
	const idCounts = new Map<string, number>();
	const criteria: AcceptanceCriterion[] = [];
	for (const value of values) {
		const text = value.trim().replace(/\s+/g, " ");
		const duplicateKey = text.toLocaleLowerCase();
		if (!text || seen.has(duplicateKey)) continue;
		seen.add(duplicateKey);
		const baseId = criterionId(text);
		const count = (idCounts.get(baseId) ?? 0) + 1;
		idCounts.set(baseId, count);
		criteria.push({ id: count === 1 ? baseId : `${baseId}-${count}`, text, source });
	}
	return criteria;
}

function criterionId(text: string): string {
	return (
		text
			.toLocaleLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "criterion"
	);
}
