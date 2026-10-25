import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { newDefinitionNameError, runCreationFlow } from "./creation-flow";
import { EMPTY_GROUPS } from "./group-policy";
import { FALLBACK } from "./profile-policy";

function context(inputs: string[], selections: string[]): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			input: async () => inputs.shift(),
			select: async () => selections.shift(),
		},
	} as unknown as ExtensionContext;
}

test("shared creation flow builds groups from global skills only", async () => {
	const result = await runCreationFlow({
		ctx: context(["backend"], ["○ a", "Save selection"]),
		kind: "group",
		profiles: FALLBACK,
		groups: EMPTY_GROUPS,
		skills: [
			{ name: "a", scope: "user" },
			{ name: "p", scope: "project" },
		],
	});
	assert.deepEqual(result, { kind: "group", name: "backend", skills: ["a"] });
});

test("shared creation flow builds profiles from group references and individual globals", async () => {
	const result = await runCreationFlow({
		ctx: context(["work"], ["○ backend", "Save selection", "○ a", "Save selection"]),
		kind: "profile",
		profiles: FALLBACK,
		groups: { schemaVersion: 1, groups: { backend: { skills: ["a"] } } },
		skills: [
			{ name: "a", scope: "user" },
			{ name: "p", scope: "project" },
		],
	});
	assert.deepEqual(result, { kind: "profile", name: "work", groups: ["backend"], skills: ["a"] });
});

test("new names reject reserved, unsafe, and colliding values", () => {
	assert.match(newDefinitionNameError("core", {}) ?? "", /reserved/);
	assert.match(newDefinitionNameError("two words", {}) ?? "", /letters/);
	assert.match(newDefinitionNameError("work", { work: {} }) ?? "", /exists/);
	assert.equal(newDefinitionNameError("work-2", {}), undefined);
});
