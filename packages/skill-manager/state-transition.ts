import { createSkillCatalog, type SkillCatalog } from "./catalog";
import type { SelectedSkillSet } from "./types";

export interface StoredSkillManagerSelection {
	disabledSkills: ReadonlySet<string>;
	selectedSkillSet?: SelectedSkillSet;
}

export interface SkillManagerSelection {
	disabledSkills: ReadonlySet<string>;
	selectedSkillSet: SelectedSkillSet;
}

export type SkillTransitionIntent =
	| { type: "all" }
	| { type: "none" }
	| { type: "enable"; targets: string[] }
	| { type: "disable"; targets: string[] }
	| { type: "only"; targets: string[] }
	| { type: "toggle"; targets: string[] };

export type SkillTransitionEvent =
	| "all-enabled"
	| "none-enabled"
	| "targets-enabled"
	| "targets-disabled"
	| "only-targets-enabled"
	| "targets-toggled";

export type SkillTransitionResult =
	| {
			ok: true;
			selection: SkillManagerSelection;
			event: SkillTransitionEvent;
			changed: boolean;
			affectedCount: number;
	  }
	| {
			ok: false;
			reason: "missing-targets" | "unknown-targets" | "empty-targets";
			unknownTargets?: string[];
			emptyTargets?: string[];
	  };

export interface SkillStateGateway {
	current(): SkillManagerSelection;
	replace(selection: SkillManagerSelection): void;
	saveAndRefresh(): Promise<void>;
}

export function normalizeSelection(
	selection: StoredSkillManagerSelection,
	catalog: SkillCatalog,
): SkillManagerSelection {
	return {
		disabledSkills: new Set(selection.disabledSkills),
		selectedSkillSet: catalog.selectionForCurrentState,
	};
}

export function transitionSkillSelection(
	selection: SkillManagerSelection,
	intent: SkillTransitionIntent,
	catalog: SkillCatalog,
): SkillTransitionResult {
	const disabledSkills = new Set(selection.disabledSkills);
	const before = keyOf(disabledSkills);

	if (intent.type === "all") {
		disabledSkills.clear();
		return success(disabledSkills, { kind: "all" }, "all-enabled", before, catalog.skills.length);
	}

	if (intent.type === "none") {
		disabledSkills.clear();
		for (const skill of catalog.skills) disabledSkills.add(skill.name);
		return success(disabledSkills, { kind: "none" }, "none-enabled", before, catalog.skills.length);
	}

	if (intent.targets.length === 0) return { ok: false, reason: "missing-targets" };

	const targets = catalog.expandTargets(intent.targets);
	if (targets.unknownTargets.length > 0)
		return { ok: false, reason: "unknown-targets", unknownTargets: targets.unknownTargets };
	if (targets.emptyTargets.length > 0)
		return { ok: false, reason: "empty-targets", emptyTargets: targets.emptyTargets };

	if (intent.type === "only") {
		disabledSkills.clear();
		for (const skill of catalog.skills) if (!targets.names.includes(skill.name)) disabledSkills.add(skill.name);
		return success(
			disabledSkills,
			selectedSkillSetForOnly(intent.targets),
			"only-targets-enabled",
			before,
			targets.names.length,
		);
	}

	if (intent.type === "enable") {
		for (const name of targets.names) disabledSkills.delete(name);
		return success(disabledSkills, undefined, "targets-enabled", before, targets.names.length, catalog);
	}

	if (intent.type === "disable") {
		for (const name of targets.names) disabledSkills.add(name);
		return success(disabledSkills, undefined, "targets-disabled", before, targets.names.length, catalog);
	}

	for (const target of intent.targets) {
		const names = catalog.expandTargets([target]).names;
		const shouldEnable = names.some((name) => disabledSkills.has(name));
		for (const name of names) shouldEnable ? disabledSkills.delete(name) : disabledSkills.add(name);
	}
	return success(disabledSkills, undefined, "targets-toggled", before, targets.names.length, catalog);
}

function success(
	disabledSkills: Set<string>,
	selectedSkillSet: SelectedSkillSet | undefined,
	event: SkillTransitionEvent,
	before: string,
	affectedCount: number,
	catalog?: SkillCatalog,
): Extract<SkillTransitionResult, { ok: true }> {
	return {
		ok: true,
		selection: {
			disabledSkills: new Set(disabledSkills),
			selectedSkillSet: selectedSkillSet ?? deriveSelectedSkillSet(disabledSkills, catalog),
		},
		event,
		changed: keyOf(disabledSkills) !== before,
		affectedCount,
	};
}

function deriveSelectedSkillSet(disabledSkills: ReadonlySet<string>, catalog?: SkillCatalog): SelectedSkillSet {
	if (!catalog) return { kind: "custom" };
	return createSkillCatalog({ skills: catalog.skills, groupsConfig: catalog.groups, disabledSkills })
		.selectionForCurrentState;
}

function selectedSkillSetForOnly(targets: string[]): SelectedSkillSet {
	return targets.every((target) => target.startsWith("@"))
		? { kind: "groups", groups: targets.map((target) => target.slice(1)).sort() }
		: { kind: "custom" };
}

function keyOf(disabledSkills: ReadonlySet<string>) {
	return Array.from(disabledSkills).sort().join("\0");
}
