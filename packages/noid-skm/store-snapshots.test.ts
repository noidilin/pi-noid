import assert from "node:assert/strict";
import { test } from "vitest";
import { createSkillCatalog } from "./catalog.ts";
import { normalizeSkillGroupsConfig } from "./groups-store.ts";
import { normalizeSkillManagerStateConfig } from "./state-store.ts";
import { getGlobalAgentSkills } from "./global-skills.ts";
import { transitionSkillSelection } from "./state-transition.ts";

test("groups snapshot normalization accepts missing and valid config", () => {
	assert.deepEqual(normalizeSkillGroupsConfig(undefined), { groups: {}, issues: [] });
	assert.deepEqual(normalizeSkillGroupsConfig({ core: ["diagnose", "tdd"] }), {
		groups: { core: ["diagnose", "tdd"] },
		issues: [],
	});
});

test("groups snapshot normalization reports invalid config while preserving valid members", () => {
	assert.deepEqual(normalizeSkillGroupsConfig([]).issues, [{ kind: "invalid-groups-config", actual: "array" }]);
	assert.deepEqual(normalizeSkillGroupsConfig({ core: ["diagnose", 1], broken: "nope" }), {
		groups: { core: ["diagnose"] },
		issues: [
			{ kind: "invalid-group-members", group: "broken", actual: "string" },
			{ kind: "invalid-group-member", group: "core", value: 1 },
		],
	});
});

test("state snapshot normalization preserves strings and ignores invalid selected skill sets", () => {
	const result = normalizeSkillManagerStateConfig({
		disabledSkills: ["diagnose", 3],
		selectedSkillSet: { kind: "groups", groups: ["core"] },
	});
	assert.deepEqual(Array.from(result.disabledSkills), ["diagnose"]);
	assert.deepEqual(result.selectedSkillSet, { kind: "groups", groups: ["core"] });

	const invalid = normalizeSkillManagerStateConfig({
		disabledSkills: ["diagnose"],
		selectedSkillSet: { kind: "groups", groups: [1] },
	});
	assert.deepEqual(Array.from(invalid.disabledSkills), ["diagnose"]);
	assert.equal(invalid.selectedSkillSet, undefined);
});

test("project skills stay enabled even when disabled in state", () => {
	const catalog = createSkillCatalog({
		skills: [
			{ name: "project-skill", scope: "project" },
			{ name: "user-skill", scope: "user" },
		],
		groupsConfig: {},
		disabledSkills: new Set(["project-skill", "user-skill"]),
	});

	assert.deepEqual(catalog.protectedProjectSkillNames, ["project-skill"]);
	assert.deepEqual(catalog.protectedDisabledProjectSkillNames, ["project-skill"]);
	assert.deepEqual(catalog.enabledSkillNames, ["project-skill"]);
	assert.deepEqual(catalog.disabledSkillNames, ["user-skill"]);
});

test("transitions never add project skills to disabled state", () => {
	const catalog = createSkillCatalog({
		skills: [
			{ name: "project-skill", scope: "project" },
			{ name: "user-skill", scope: "user" },
		],
		groupsConfig: {},
		disabledSkills: new Set(),
	});

	const none = transitionSkillSelection(
		{ disabledSkills: new Set(), selectedSkillSet: { kind: "all" } },
		{ type: "none" },
		catalog,
	);
	assert.equal(none.ok, true);
	if (none.ok) assert.deepEqual(Array.from(none.selection.disabledSkills), ["user-skill"]);

	const disableProject = transitionSkillSelection(
		{ disabledSkills: new Set(), selectedSkillSet: { kind: "all" } },
		{ type: "disable", targets: ["project-skill"] },
		catalog,
	);
	assert.equal(disableProject.ok, true);
	if (disableProject.ok) assert.deepEqual(Array.from(disableProject.selection.disabledSkills), []);
});

test("global agent skill helper detects user skill roots", () => {
	const home = process.env.HOME ?? "/Users/example";
	assert.deepEqual(
		getGlobalAgentSkills([
			{ name: "deploy", scope: "user", path: `${home}/.agents/skills/deploy/SKILL.md` },
			{ name: "project-local", scope: "project", path: `${home}/work/project/.agents/skills/project-local/SKILL.md` },
			{ name: "pi-global", scope: "user", path: `${home}/.pi/agent/skills/pi-global/SKILL.md` },
		]).map((skill) => skill.name),
		["deploy", "pi-global"],
	);
});
