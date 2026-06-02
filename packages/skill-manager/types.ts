export type SelectedSkillSet =
	| { kind: "all" }
	| { kind: "none" }
	| { kind: "groups"; groups: string[] }
	| { kind: "custom" };

export interface SkillManagerState {
	version: 1;
	disabledSkills: string[];
	selectedSkillSet?: SelectedSkillSet;
}

export interface SkillItem {
	name: string;
	description?: string;
	path?: string;
	scope?: string;
}

export type SkillGroups = Record<string, string[]>;

export type StoreLoadSnapshot = { status: "loaded" } | { status: "missing" } | { status: "error"; message: string };

export type SkillGroupState = "enabled" | "disabled" | "partial";

export type GroupRow = {
	name: string;
	rawMembers: unknown[];
	stringMembers: string[];
	discoveredMembers: string[];
	enabledCount: number;
	totalDiscovered: number;
	state: SkillGroupState;
};

export type EffectiveSkillSet =
	| { kind: "all" }
	| { kind: "none" }
	| { kind: "exact-groups"; groups: string[] }
	| { kind: "custom"; includedGroups: string[] };

export type SkillCatalogIssue =
	| { kind: "state-load-error"; message: string }
	| { kind: "groups-load-error"; message: string }
	| { kind: "invalid-groups-config"; actual: string }
	| { kind: "invalid-group-members"; group: string; actual: string }
	| { kind: "invalid-group-member"; group: string; value: unknown }
	| { kind: "empty-group"; group: string }
	| { kind: "no-discovered-group-members"; group: string }
	| { kind: "unknown-group-skill"; group: string; skill: string }
	| { kind: "duplicate-group-skill"; group: string; skill: string }
	| { kind: "skill-in-multiple-groups"; skill: string; groups: string[] }
	| { kind: "unassigned-skill"; skill: string }
	| { kind: "stale-disabled-skill"; skill: string }
	| { kind: "stale-selected-skill-set"; selectedSkillSet: SelectedSkillSet; current: SelectedSkillSet }
	| { kind: "duplicate-discovered-skill"; skill: string; paths: string[] }
	| { kind: "duplicate-group-skill-set"; groups: string[]; members: string[] }
	| { kind: "too-many-groups-for-exact-match"; groupCount: number; limit: number };

export interface ExpandTargetsResult {
	names: string[];
	unknownTargets: string[];
	emptyTargets: string[];
}

export type LoadErrorGetter = () => string | undefined;
