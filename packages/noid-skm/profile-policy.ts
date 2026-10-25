import type { GroupConfig } from "./group-policy";
import type { SkillItem } from "./types";

export interface ProfileDefinition {
	groups: string[];
	skills: string[];
}

export interface ProfileConfig {
	schemaVersion: 3;
	defaultProfile: string;
	coreSkills: string[];
	profiles: Record<string, ProfileDefinition>;
}

export const FALLBACK: ProfileConfig = { schemaVersion: 3, defaultProfile: "", coreSkills: [], profiles: {} };
export const sortedNames = (names: Iterable<string>) => [...new Set(names)].sort();

export function parseProfiles(raw: unknown): ProfileConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid profiles configuration");
	const value = raw as Record<string, unknown>;
	if (value.schemaVersion !== 3)
		throw new Error(`Unsupported profiles schema version: ${String(value.schemaVersion)}`);
	if (
		typeof value.defaultProfile !== "string" ||
		!validNames(value.coreSkills) ||
		!value.profiles ||
		typeof value.profiles !== "object" ||
		Array.isArray(value.profiles)
	)
		throw new Error("Invalid profiles configuration");
	const profiles: ProfileConfig["profiles"] = {};
	for (const [name, definition] of Object.entries(value.profiles)) {
		const candidate = definition as { groups?: unknown; skills?: unknown } | undefined;
		if (
			!name.trim() ||
			name === "core" ||
			!candidate ||
			typeof candidate !== "object" ||
			!validNames(candidate.groups) ||
			!validNames(candidate.skills)
		)
			throw new Error(`Invalid profile: ${name}`);
		profiles[name] = { groups: sortedNames(candidate.groups), skills: sortedNames(candidate.skills) };
	}
	return {
		schemaVersion: 3,
		defaultProfile: value.defaultProfile,
		coreSkills: sortedNames(value.coreSkills),
		profiles,
	};
}

export function upgradeProfiles(raw: unknown): { config: ProfileConfig; upgraded: boolean } {
	if (
		raw &&
		typeof raw === "object" &&
		!Array.isArray(raw) &&
		(raw as { schemaVersion?: unknown }).schemaVersion === 2
	) {
		const value = raw as Record<string, unknown>;
		if (
			typeof value.defaultProfile !== "string" ||
			!validNames(value.coreSkills) ||
			!value.profiles ||
			typeof value.profiles !== "object" ||
			Array.isArray(value.profiles)
		)
			throw new Error("Invalid profiles configuration");
		const profiles: ProfileConfig["profiles"] = {};
		for (const [name, definition] of Object.entries(value.profiles)) {
			const skills = (definition as { skills?: unknown } | undefined)?.skills;
			if (!name.trim() || name === "core" || !validNames(skills)) throw new Error(`Invalid profile: ${name}`);
			profiles[name] = { groups: [], skills: sortedNames(skills) };
		}
		return {
			config: {
				schemaVersion: 3,
				defaultProfile: value.defaultProfile,
				coreSkills: sortedNames(value.coreSkills),
				profiles,
			},
			upgraded: true,
		};
	}
	return { config: parseProfiles(raw), upgraded: false };
}

function validNames(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((name) => typeof name === "string" && name.trim().length > 0);
}

export interface ProfileResolution {
	names: string[];
	unknownSkills: string[];
	unknownGroups: string[];
}

export function resolveProfile(
	config: ProfileConfig,
	groups: GroupConfig,
	profileName: string,
	installed: readonly SkillItem[],
): ProfileResolution {
	const available = new Set(installed.filter((skill) => skill.scope !== "project").map((skill) => skill.name));
	const profile = config.profiles[profileName];
	const unknownGroups = sortedNames((profile?.groups ?? []).filter((name) => !groups.groups[name]));
	const groupSkills = (profile?.groups ?? []).flatMap((name) => groups.groups[name]?.skills ?? []);
	const members = [...config.coreSkills, ...(profile?.skills ?? []), ...groupSkills];
	return {
		names: sortedNames(members.filter((name) => available.has(name))),
		unknownSkills: sortedNames(members.filter((name) => !available.has(name))),
		unknownGroups,
	};
}

export function chooseProfile(config: ProfileConfig, flag: unknown): { name: string; diagnostics: string[] } {
	const diagnostics: string[] = [];
	if (typeof flag === "string" && flag) {
		if (config.profiles[flag]) return { name: flag, diagnostics };
		diagnostics.push(`Unknown --skill-profile: ${flag}`);
	}
	if (config.profiles[config.defaultProfile]) return { name: config.defaultProfile, diagnostics };
	if (config.defaultProfile) diagnostics.push(`Unknown default profile: ${config.defaultProfile}`);
	return { name: "fallback", diagnostics };
}
