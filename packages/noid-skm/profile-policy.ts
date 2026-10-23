import type { SkillItem } from "./types";

export interface ProfileConfig {
	schemaVersion: 2;
	defaultProfile: string;
	coreSkills: string[];
	profiles: Record<string, { skills: string[] }>;
}

export const FALLBACK: ProfileConfig = { schemaVersion: 2, defaultProfile: "", coreSkills: [], profiles: {} };
export const sortedNames = (names: Iterable<string>) => [...new Set(names)].sort();

export function parseProfiles(raw: unknown): ProfileConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid profiles configuration");
	const value = raw as Record<string, unknown>;
	if (value.schemaVersion !== 2)
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
		if (
			!name.trim() ||
			name === "core" ||
			!definition ||
			typeof definition !== "object" ||
			!validNames((definition as { skills?: unknown }).skills)
		)
			throw new Error(`Invalid profile: ${name}`);
		profiles[name] = { skills: sortedNames((definition as { skills: string[] }).skills) };
	}
	return {
		schemaVersion: 2,
		defaultProfile: value.defaultProfile,
		coreSkills: sortedNames(value.coreSkills),
		profiles,
	};
}

function validNames(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((name) => typeof name === "string" && name.trim().length > 0);
}

export function resolveProfile(config: ProfileConfig, profileName: string, installed: readonly SkillItem[]) {
	const available = new Set(installed.filter((skill) => skill.scope !== "project").map((skill) => skill.name));
	const members = [...config.coreSkills, ...(config.profiles[profileName]?.skills ?? [])];
	return {
		names: sortedNames(members.filter((name) => available.has(name))),
		unknown: sortedNames(members.filter((name) => !available.has(name))),
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
