import { isProjectSkill } from "./types";
import type {
	EffectiveSkillSet,
	ExpandTargetsResult,
	GroupRow,
	SelectedSkillSet,
	SkillCatalogIssue,
	SkillGroups,
	SkillItem,
} from "./types";

const EXACT_GROUP_MATCH_LIMIT = 20;
const SCOPE_PRIORITY: Record<string, number> = { project: 0, user: 1, temporary: 2 };

export interface SkillCatalogInput {
	skills: SkillItem[];
	groupsConfig: SkillGroups;
	disabledSkills: ReadonlySet<string>;
	selectedSkillSet?: SelectedSkillSet;
	storeIssues?: SkillCatalogIssue[];
}

export interface SkillCatalog {
	skills: SkillItem[];
	skillsByName: ReadonlyMap<string, SkillItem>;
	groups: SkillGroups;
	groupsByName: ReadonlyMap<string, GroupRow>;
	groupRows: GroupRow[];
	memberships: ReadonlyMap<string, string[]>;
	persistedDisabledSkillNames: string[];
	staleDisabledSkillNames: string[];
	protectedProjectSkillNames: string[];
	protectedDisabledProjectSkillNames: string[];
	enabledSkills: SkillItem[];
	disabledSkills: SkillItem[];
	enabledSkillNames: string[];
	disabledSkillNames: string[];
	effectiveSkillSet: EffectiveSkillSet;
	selectionForCurrentState: SelectedSkillSet;
	issues: SkillCatalogIssue[];
	expandTargets(targets: string[]): ExpandTargetsResult;
}

export function createSkillCatalog(input: SkillCatalogInput): SkillCatalog {
	const issues: SkillCatalogIssue[] = [...(input.storeIssues ?? [])];

	const { skills, skillsByName } = normalizeSkills(input.skills, issues);
	const rawGroupRows = normalizeGroupConfig(input.groupsConfig);
	const skillNames = new Set(skills.map((skill) => skill.name));
	const protectedProjectSkillNames = skills.filter(isProjectSkill).map((skill) => skill.name).sort();
	const protectedProjectSkillNameSet = new Set(protectedProjectSkillNames);
	const persistedDisabledSkillNames = Array.from(input.disabledSkills).sort();
	const staleDisabledSkillNames = persistedDisabledSkillNames.filter((name) => !skillNames.has(name));
	const protectedDisabledProjectSkillNames = persistedDisabledSkillNames.filter((name) =>
		protectedProjectSkillNameSet.has(name),
	);
	const effectiveDisabledSkills = new Set(
		persistedDisabledSkillNames.filter((name) => !protectedProjectSkillNameSet.has(name)),
	);
	for (const skill of staleDisabledSkillNames) issues.push({ kind: "stale-disabled-skill", skill });
	for (const skill of protectedDisabledProjectSkillNames)
		issues.push({ kind: "protected-project-skill-disabled", skill });

	const groupRows = rawGroupRows
		.map(({ name, rawMembers, stringMembers }) => {
			const discoveredMembers = Array.from(new Set(stringMembers.filter((member) => skillNames.has(member)))).sort();
			const enabledCount = discoveredMembers.filter((member) => !effectiveDisabledSkills.has(member)).length;
			const state =
				discoveredMembers.length === 0 || enabledCount === 0
					? "disabled"
					: enabledCount === discoveredMembers.length
						? "enabled"
						: "partial";
			return {
				name,
				rawMembers,
				stringMembers: [...stringMembers].sort(),
				discoveredMembers,
				enabledCount,
				totalDiscovered: discoveredMembers.length,
				state,
			} satisfies GroupRow;
		})
		.sort((a, b) => a.name.localeCompare(b.name));

	for (const row of groupRows) {
		if (row.rawMembers.length === 0) issues.push({ kind: "empty-group", group: row.name });
		if (row.rawMembers.length > 0 && row.discoveredMembers.length === 0)
			issues.push({ kind: "no-discovered-group-members", group: row.name });
		const seen = new Set<string>();
		const duplicates = new Set<string>();
		for (const member of row.stringMembers) {
			if (seen.has(member)) duplicates.add(member);
			seen.add(member);
			if (!skillNames.has(member)) issues.push({ kind: "unknown-group-skill", group: row.name, skill: member });
		}
		for (const skill of Array.from(duplicates).sort())
			issues.push({ kind: "duplicate-group-skill", group: row.name, skill });
	}

	const groups = Object.fromEntries(groupRows.map((row) => [row.name, row.stringMembers])) as SkillGroups;
	const groupsByName = new Map(groupRows.map((row) => [row.name, row]));
	const memberships = buildMemberships(groupRows, issues);
	for (const skill of skills)
		if (!memberships.has(skill.name)) issues.push({ kind: "unassigned-skill", skill: skill.name });
	reportDuplicateGroupSkillSets(groupRows, issues);

	const enabledSkills = skills.filter((skill) => !effectiveDisabledSkills.has(skill.name));
	const disabledSkills = skills.filter((skill) => effectiveDisabledSkills.has(skill.name));
	const enabledSkillNames = enabledSkills.map((skill) => skill.name);
	const disabledSkillNames = disabledSkills.map((skill) => skill.name);
	const exactMatchSkipped = groupRows.length > EXACT_GROUP_MATCH_LIMIT;
	if (exactMatchSkipped)
		issues.push({
			kind: "too-many-groups-for-exact-match",
			groupCount: groupRows.length,
			limit: EXACT_GROUP_MATCH_LIMIT,
		});
	const effectiveSkillSet = getEffectiveSkillSet(enabledSkillNames, skills.length, groupRows, exactMatchSkipped);
	const selectionForCurrentState = toSelectedSkillSet(effectiveSkillSet);
	if (input.selectedSkillSet && !sameSelectedSkillSet(input.selectedSkillSet, selectionForCurrentState)) {
		issues.push({
			kind: "stale-selected-skill-set",
			selectedSkillSet: input.selectedSkillSet,
			current: selectionForCurrentState,
		});
	}

	return {
		skills,
		skillsByName,
		groups,
		groupsByName,
		groupRows,
		memberships,
		persistedDisabledSkillNames,
		staleDisabledSkillNames,
		protectedProjectSkillNames,
		protectedDisabledProjectSkillNames,
		enabledSkills,
		disabledSkills,
		enabledSkillNames,
		disabledSkillNames,
		effectiveSkillSet,
		selectionForCurrentState,
		issues: sortIssues(issues),
		expandTargets(targets) {
			return expandTargets(targets, skillsByName, groupsByName);
		},
	};
}

function normalizeSkills(inputSkills: SkillItem[], issues: SkillCatalogIssue[]) {
	const sorted = [...inputSkills].sort(compareSkills);
	const grouped = new Map<string, SkillItem[]>();
	for (const skill of sorted) grouped.set(skill.name, [...(grouped.get(skill.name) ?? []), skill]);
	const skills: SkillItem[] = [];
	for (const [name, items] of Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b))) {
		skills.push(items[0]!);
		if (items.length > 1)
			issues.push({
				kind: "duplicate-discovered-skill",
				skill: name,
				paths: items.map((item) => item.path ?? "(unknown)").sort(),
			});
	}
	return { skills, skillsByName: new Map(skills.map((skill) => [skill.name, skill])) };
}

function compareSkills(a: SkillItem, b: SkillItem) {
	return (
		a.name.localeCompare(b.name) ||
		(SCOPE_PRIORITY[a.scope ?? ""] ?? 99) - (SCOPE_PRIORITY[b.scope ?? ""] ?? 99) ||
		(a.path ?? "").localeCompare(b.path ?? "")
	);
}

function normalizeGroupConfig(groups: SkillGroups) {
	return Object.entries(groups)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, stringMembers]) => ({ name, rawMembers: [...stringMembers], stringMembers: [...stringMembers] }));
}

function buildMemberships(groupRows: GroupRow[], issues: SkillCatalogIssue[]) {
	const memberships = new Map<string, string[]>();
	for (const row of groupRows) {
		for (const member of row.discoveredMembers)
			memberships.set(member, [...(memberships.get(member) ?? []), row.name].sort());
	}
	for (const [skill, groups] of memberships)
		if (groups.length > 1)
			issues.push({ kind: "skill-in-multiple-groups", skill, groups: groups.map((group) => `@${group}`) });
	return memberships;
}

function reportDuplicateGroupSkillSets(groupRows: GroupRow[], issues: SkillCatalogIssue[]) {
	const byMembers = new Map<string, GroupRow[]>();
	for (const row of groupRows) {
		if (row.discoveredMembers.length === 0) continue;
		const key = row.discoveredMembers.join("\0");
		byMembers.set(key, [...(byMembers.get(key) ?? []), row]);
	}
	for (const rows of byMembers.values()) {
		if (rows.length < 2) continue;
		issues.push({
			kind: "duplicate-group-skill-set",
			groups: rows.map((row) => `@${row.name}`).sort(),
			members: rows[0]!.discoveredMembers,
		});
	}
}

function getEffectiveSkillSet(
	enabledSkillNames: string[],
	totalSkillCount: number,
	groupRows: GroupRow[],
	exactMatchSkipped: boolean,
): EffectiveSkillSet {
	if (enabledSkillNames.length === totalSkillCount) return { kind: "all" };
	if (enabledSkillNames.length === 0) return { kind: "none" };
	const enabledSet = new Set(enabledSkillNames);
	const exactGroups = exactMatchSkipped ? undefined : findSmallestExactGroupCombination(enabledSet, groupRows);
	if (exactGroups) return { kind: "exact-groups", groups: exactGroups };
	return {
		kind: "custom",
		includedGroups: groupRows
			.filter(
				(row) =>
					row.discoveredMembers.length > 0 && row.discoveredMembers.every((member) => enabledSet.has(member)),
			)
			.map((row) => row.name)
			.sort(),
	};
}

function findSmallestExactGroupCombination(enabledSet: Set<string>, groupRows: GroupRow[]) {
	const candidates = groupRows
		.filter(
			(row) => row.discoveredMembers.length > 0 && row.discoveredMembers.every((member) => enabledSet.has(member)),
		)
		.sort((a, b) => a.name.localeCompare(b.name));
	for (let size = 1; size <= candidates.length; size++) {
		let best: string[] | undefined;
		for (const combo of combinations(candidates, size)) {
			const union = new Set(combo.flatMap((row) => row.discoveredMembers));
			if (!sameSet(union, enabledSet)) continue;
			const names = combo.map((row) => row.name).sort();
			if (!best || names.join("\0").localeCompare(best.join("\0")) < 0) best = names;
		}
		if (best) return best;
	}
	return undefined;
}

function* combinations<T>(items: T[], size: number, start = 0, prefix: T[] = []): Generator<T[]> {
	if (prefix.length === size) {
		yield prefix;
		return;
	}
	for (let index = start; index <= items.length - (size - prefix.length); index++)
		yield* combinations(items, size, index + 1, [...prefix, items[index]!]);
}

function sameSet(a: Set<string>, b: Set<string>) {
	return a.size === b.size && Array.from(a).every((value) => b.has(value));
}

function toSelectedSkillSet(skillSet: EffectiveSkillSet): SelectedSkillSet {
	if (skillSet.kind === "all" || skillSet.kind === "none") return skillSet;
	if (skillSet.kind === "exact-groups") return { kind: "groups", groups: skillSet.groups };
	return { kind: "custom" };
}

function sameSelectedSkillSet(a: SelectedSkillSet, b: SelectedSkillSet) {
	if (a.kind !== b.kind) return false;
	if (a.kind !== "groups" || b.kind !== "groups") return true;
	return a.groups.join("\0") === b.groups.join("\0");
}

function expandTargets(
	targets: string[],
	skillsByName: ReadonlyMap<string, SkillItem>,
	groupsByName: ReadonlyMap<string, GroupRow>,
): ExpandTargetsResult {
	const names = new Set<string>();
	const unknownTargets: string[] = [];
	const emptyTargets: string[] = [];
	for (const target of targets) {
		if (target.startsWith("@")) {
			const group = groupsByName.get(target.slice(1));
			if (!group) unknownTargets.push(target);
			else if (group.discoveredMembers.length === 0) emptyTargets.push(target);
			else for (const member of group.discoveredMembers) names.add(member);
			continue;
		}
		if (skillsByName.has(target)) names.add(target);
		else unknownTargets.push(target);
	}
	return { names: Array.from(names).sort(), unknownTargets: unknownTargets.sort(), emptyTargets: emptyTargets.sort() };
}

function sortIssues(issues: SkillCatalogIssue[]) {
	return [...issues].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
