import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeSkillGroupsConfig } from "./groups-store.ts";
import { normalizeSkillManagerStateConfig } from "./state-store.ts";

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
