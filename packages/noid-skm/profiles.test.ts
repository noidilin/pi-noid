import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry, Skill } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { EMPTY_GROUPS, parseGroups } from "./group-policy";
import { GroupsStore } from "./groups-store";
import { PROFILE_CUSTOM_TYPE } from "./paths";
import { chooseProfile, parseProfiles, resolveProfile } from "./profile-policy";
import { initialProfiles, ProfilesStore } from "./profiles-store";
import { lockProfile, persistedProfile, reconstructProfile, selectProfile } from "./session-profile";
import { filterSkills } from "./skill-filter";

const installed = [
	{ name: "a", scope: "user" },
	{ name: "b", scope: "temporary" },
	{ name: "p", scope: "project" },
];
const raw = {
	schemaVersion: 3,
	defaultProfile: "work",
	coreSkills: ["b", "b", "absent"],
	profiles: {
		work: { groups: ["backend", "missing", "backend"], skills: ["a", "b", "a"] },
		empty: { groups: [], skills: [] },
	},
};
const groupConfig = parseGroups({
	schemaVersion: 1,
	groups: { backend: { skills: ["b", "p", "old", "b"] } },
});

test("validation, group expansion, resolution and safe fallback", () => {
	const config = parseProfiles(raw);
	assert.deepEqual(resolveProfile(config, groupConfig, "work", installed), {
		names: ["a", "b"],
		unknownSkills: ["absent", "old", "p"],
		unknownGroups: ["missing"],
	});
	assert.deepEqual(resolveProfile(config, EMPTY_GROUPS, "empty", installed).names, ["b"]);
	assert.deepEqual(resolveProfile(config, groupConfig, "work", [...installed, { name: "new", scope: "user" }]).names, [
		"a",
		"b",
	]);
	assert.equal(chooseProfile(config, "bad").name, "work");
	assert.equal(chooseProfile({ ...config, defaultProfile: "missing" }, undefined).name, "fallback");
	for (const invalid of [
		null,
		{},
		{ ...raw, schemaVersion: 4 },
		{ ...raw, profiles: { core: { groups: [], skills: [] } } },
		{ ...raw, coreSkills: [2] },
		{ ...raw, profiles: { bad: { skills: [] } } },
	])
		assert.throws(() => parseProfiles(invalid));
});

test("group config validates, sorts, and deduplicates", () => {
	assert.deepEqual(groupConfig.groups.backend.skills, ["b", "old", "p"]);
	for (const invalid of [
		null,
		{},
		{ schemaVersion: 2, groups: {} },
		{ schemaVersion: 1, groups: { core: { skills: [] } } },
	])
		assert.throws(() => parseGroups(invalid));
});

test("initial global profile includes discovered globals, not project skills", () => {
	const config = initialProfiles([...installed, { name: "a", scope: "user" }]);
	assert.equal(config.defaultProfile, "global");
	assert.deepEqual(config.profiles.global, { groups: [], skills: ["a", "b"] });
	assert.deepEqual(config.coreSkills, []);
});

test("profile store bootstraps, upgrades v2, creates profiles, and refuses malformed profiles", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skm-profiles-"));
	try {
		const path = join(dir, "profiles.json");
		await writeFile(join(dir, "skill-manager.json"), "broken legacy data");
		const store = new ProfilesStore(path);
		assert.equal((await store.load([])).readOnly, true);
		assert.equal((await store.load(installed)).created, true);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")).profiles.global.skills, ["a", "b"]);
		await store.create("small", { groups: ["backend"], skills: ["a", "a"] });
		assert.deepEqual(store.snapshot().config.profiles.small, { groups: ["backend"], skills: ["a"] });

		const v2Path = join(dir, "v2.json");
		await writeFile(
			v2Path,
			JSON.stringify({
				schemaVersion: 2,
				defaultProfile: "work",
				coreSkills: [],
				profiles: { work: { skills: ["a"] } },
			}),
		);
		const upgraded = await new ProfilesStore(v2Path).load(installed);
		assert.equal(upgraded.upgraded, true);
		assert.deepEqual(upgraded.config.profiles.work, { groups: [], skills: ["a"] });
		assert.equal(JSON.parse(await readFile(v2Path, "utf8")).schemaVersion, 3);

		await writeFile(path, "broken");
		const broken = await new ProfilesStore(path).load(installed);
		assert.equal(broken.readOnly, true);
		assert.deepEqual(broken.config.coreSkills, []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("group store starts empty, creates atomically, and fails closed on malformed data", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skm-groups-"));
	try {
		const path = join(dir, "groups.json");
		const store = new GroupsStore(path);
		assert.equal((await store.load()).missing, true);
		await store.create("backend", ["b", "a", "a"]);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
			schemaVersion: 1,
			groups: { backend: { skills: ["a", "b"] } },
		});
		await assert.rejects(() => store.create("backend", []), /already exists/);
		await writeFile(path, "broken");
		assert.equal((await new GroupsStore(path).load()).readOnly, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

function entry(data: unknown): SessionEntry {
	return { type: "custom", customType: PROFILE_CUSTOM_TYPE, data, id: "x", parentId: null, timestamp: "" };
}

test("branch-local selection and resolved lock snapshot remain stable", () => {
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
	groupConfig.groups.backend.skills = [];
	assert.deepEqual(reconstructProfile([entry(persistedProfile(locked))]).state, locked);
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
