import { sortedNames } from "./profile-policy";

export interface GroupConfig {
	schemaVersion: 1;
	groups: Record<string, { skills: string[] }>;
}

export const EMPTY_GROUPS: GroupConfig = { schemaVersion: 1, groups: {} };

export function parseGroups(raw: unknown): GroupConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid groups configuration");
	const value = raw as Record<string, unknown>;
	if (value.schemaVersion !== 1) throw new Error(`Unsupported groups schema version: ${String(value.schemaVersion)}`);
	if (!value.groups || typeof value.groups !== "object" || Array.isArray(value.groups))
		throw new Error("Invalid groups configuration");
	const groups: GroupConfig["groups"] = {};
	for (const [name, definition] of Object.entries(value.groups)) {
		if (
			!validDefinitionName(name) ||
			!definition ||
			typeof definition !== "object" ||
			!validNames((definition as { skills?: unknown }).skills)
		)
			throw new Error(`Invalid group: ${name}`);
		groups[name] = { skills: sortedNames((definition as { skills: string[] }).skills) };
	}
	return { schemaVersion: 1, groups };
}

export function validDefinitionName(name: string): boolean {
	return name.trim().length > 0 && name !== "core";
}

export function validNames(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((name) => typeof name === "string" && name.trim().length > 0);
}
