import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry, Skill } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { PROFILE_CUSTOM_TYPE } from "./paths";
import { chooseProfile, parseProfiles, resolveProfile } from "./profile-policy";
import { migrateLegacy, ProfilesStore } from "./profiles-store";
import { lockProfile, persistedProfile, reconstructProfile, selectProfile } from "./session-profile";
import { filterSkills } from "./skill-filter";

const installed = [
	{ name: "a", scope: "user" },
	{ name: "b", scope: "temporary" },
	{ name: "p", scope: "project" },
];
const raw = {
	schemaVersion: 2,
	defaultProfile: "work",
	coreSkills: ["b", "b", "absent"],
	profiles: { work: { skills: ["a", "b", "a"] }, empty: { skills: [] } },
};

test("validation, resolution and safe fallback", () => {
	const config = parseProfiles(raw);
	assert.deepEqual(resolveProfile(config, "work", installed), { names: ["a", "b"], unknown: ["absent"] });
	assert.deepEqual(resolveProfile(config, "empty", installed).names, ["b"]);
	assert.deepEqual(resolveProfile(config, "work", [...installed, { name: "new", scope: "user" }]).names, ["a", "b"]);
	assert.equal(chooseProfile(config, "bad").name, "work");
	assert.equal(chooseProfile({ ...config, defaultProfile: "missing" }, undefined).name, "fallback");
	for (const invalid of [
		null,
		{},
		{ ...raw, schemaVersion: 3 },
		{ ...raw, profiles: { core: { skills: [] } } },
		{ ...raw, coreSkills: [2] },
	])
		assert.throws(() => parseProfiles(invalid));
});

test("migration preserves exactly enabled installed globals and reports stale state", () => {
	const migrated = migrateLegacy(
		{ version: 1, disabledSkills: ["b", "old"], selectedSkillSet: { kind: "all" } },
		installed,
	);
	assert.deepEqual(migrated.config.profiles["legacy-imported"].skills, ["a"]);
	assert.deepEqual(migrated.config.coreSkills, []);
	assert.deepEqual(migrated.diagnostics, ["Legacy disabled skill not installed: old"]);
	assert.deepEqual(
		migrateLegacy({ version: 1, disabledSkills: ["a", "b"] }, installed).config.profiles["legacy-imported"].skills,
		[],
	);
	assert.throws(() => migrateLegacy({ version: 9, disabledSkills: [] }, installed));
});

test("store migrates once, refuses malformed data, and changes only the default", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skm-profiles-"));
	try {
		const path = join(dir, "profiles.json");
		const legacy = join(dir, "old.json");
		await writeFile(legacy, JSON.stringify({ version: 1, disabledSkills: ["b"] }));
		const store = new ProfilesStore(path, legacy);
		assert.equal((await store.load(installed)).migrated, true);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")).profiles["legacy-imported"].skills, ["a"]);
		assert.equal((await new ProfilesStore(path, legacy).load(installed)).migrated, false);
		await writeFile(legacy, "broken");
		assert.equal((await new ProfilesStore(path, legacy).load(installed)).readOnly, true);
		await writeFile(path, "broken");
		const broken = await new ProfilesStore(path, legacy).load(installed);
		assert.equal(broken.readOnly, true);
		assert.deepEqual(broken.config.coreSkills, []);
		await assert.rejects(() => new ProfilesStore(path, legacy).setDefault("work"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

function entry(data: unknown): SessionEntry {
	return { type: "custom", customType: PROFILE_CUSTOM_TYPE, data, id: "x", parentId: null, timestamp: "" };
}

test("branch-local selection and lock; forks before entry are unbound", () => {
	const selected = selectProfile({ status: "unbound" }, "work");
	const locked = lockProfile("work", ["b", "a", "a"]);
	const before = reconstructProfile([]);
	assert.equal(before.state.status, "unbound");
	assert.deepEqual(reconstructProfile([entry(persistedProfile(selected))]).state, selected);
	assert.deepEqual(
		reconstructProfile([entry(persistedProfile(selected)), entry(persistedProfile(locked))]).state,
		locked,
	);
	assert.deepEqual(locked.resolvedGlobalSkills, ["a", "b"]);
	assert.throws(() => selectProfile(locked, "empty"));
	assert.equal(
		reconstructProfile([
			{
				type: "message",
				id: "m",
				parentId: null,
				timestamp: "",
				message: { role: "user", content: [], timestamp: 0 },
			} as SessionEntry,
		]).hasHistory,
		true,
	);
});

test("structured filter retains project and unknown scope, respects snapshot and preserves objects", () => {
	const skill = (name: string, scope: string) => ({ name, sourceInfo: { scope } }) as Skill;
	const a = skill("a", "user"),
		b = skill("b", "user"),
		project = skill("b", "project"),
		unknown = skill("x", "mystery");
	const input = [a, b, project, unknown];
	const result = filterSkills(input, new Set(["a"]));
	assert.deepEqual(result.skills, [a, project, unknown]);
	assert.equal(result.skills[0], a);
	assert.deepEqual(filterSkills(input, new Set()).skills, [project, unknown]);
	assert.deepEqual(result.diagnostics, ["Unclassified skill scope: x"]);
	assert.equal(input.length, 4);
});
