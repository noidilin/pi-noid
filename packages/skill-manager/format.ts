import type { EffectiveSkillSet, SelectedSkillSet, SkillCatalogIssue } from "./types";

export function formatEffectiveSkillSet(skillSet: EffectiveSkillSet) {
	switch (skillSet.kind) {
		case "all":
			return "all";
		case "none":
			return "none";
		case "exact-groups":
			return formatGroups(skillSet.groups);
		case "custom":
			return skillSet.includedGroups.length > 0 ? `custom (${formatGroups(skillSet.includedGroups)})` : "custom";
	}
}

export function formatSelectedSkillSet(skillSet: SelectedSkillSet) {
	switch (skillSet.kind) {
		case "all":
			return "all";
		case "none":
			return "none";
		case "groups":
			return formatGroups(skillSet.groups);
		case "custom":
			return "custom";
	}
}

export function formatGroups(groups: string[]) {
	return groups.map((group) => `@${group}`).join(",");
}

export function formatIssue(issue: SkillCatalogIssue) {
	switch (issue.kind) {
		case "state-load-error":
			return `state file parse/read error: ${issue.message}`;
		case "groups-load-error":
			return `groups file parse/read error: ${issue.message}`;
		case "invalid-groups-config":
			return `groups config must be an object, got ${issue.actual}`;
		case "invalid-group-members":
			return `@${issue.group} members must be an array, got ${issue.actual}`;
		case "invalid-group-member":
			return `@${issue.group} contains non-string member: ${JSON.stringify(issue.value)}`;
		case "empty-group":
			return `@${issue.group} is empty`;
		case "no-discovered-group-members":
			return `@${issue.group} has no discovered members`;
		case "unknown-group-skill":
			return `@${issue.group} references unknown skill: ${issue.skill}`;
		case "duplicate-group-skill":
			return `@${issue.group} duplicates skill: ${issue.skill}`;
		case "skill-in-multiple-groups":
			return `${issue.skill} appears in multiple groups: ${issue.groups.join(", ")}`;
		case "unassigned-skill":
			return `${issue.skill} is not assigned to any group`;
		case "stale-disabled-skill":
			return `state disables unknown/stale skill: ${issue.skill}`;
		case "stale-selected-skill-set":
			return `selectedSkillSet ${formatSelectedSkillSet(issue.selectedSkillSet)} does not match effective state: ${formatSelectedSkillSet(issue.current)}`;
		case "duplicate-discovered-skill":
			return `${issue.skill} is discovered multiple times: ${issue.paths.join(", ")}`;
		case "duplicate-group-skill-set":
			return `${issue.groups.join(", ")} have identical discovered members: ${issue.members.join(", ")}`;
		case "too-many-groups-for-exact-match":
			return `exact group matching skipped: ${issue.groupCount} groups exceeds limit ${issue.limit}`;
	}
}
