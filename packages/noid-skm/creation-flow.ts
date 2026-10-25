import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GroupConfig } from "./group-policy";
import type { ProfileConfig } from "./profile-policy";
import { sortedNames } from "./profile-policy";
import type { SkillItem } from "./types";

export type CreationResult =
	| { kind: "group"; name: string; skills: string[] }
	| { kind: "profile"; name: string; groups: string[]; skills: string[] };

export function newDefinitionNameError(name: string, existing: Record<string, unknown>): string | undefined {
	if (!name) return "Name is required.";
	if (name === "core") return '"core" is reserved.';
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
		return "Use letters, numbers, dots, underscores, or hyphens; start with a letter or number.";
	if (existing[name]) return `Already exists: ${name}`;
	return undefined;
}

async function chooseMany(
	ctx: ExtensionContext,
	title: string,
	values: readonly string[],
): Promise<string[] | undefined> {
	const selected = new Set<string>();
	const sorted = sortedNames(values);
	for (;;) {
		const options = [
			"Save selection",
			"Cancel",
			...sorted.map((value) => `${selected.has(value) ? "✓" : "○"} ${value}`),
		];
		const choice = await ctx.ui.select(`${title} (${selected.size} selected)`, options);
		if (!choice || choice === "Cancel") return undefined;
		if (choice === "Save selection") return sortedNames(selected);
		const value = choice.slice(2);
		if (!sorted.includes(value)) continue;
		if (selected.has(value)) selected.delete(value);
		else selected.add(value);
	}
}

export async function runCreationFlow(input: {
	ctx: ExtensionContext;
	kind: "group" | "profile";
	profiles: ProfileConfig;
	groups: GroupConfig;
	skills: readonly SkillItem[];
}): Promise<CreationResult | undefined> {
	const { ctx, kind, profiles, groups } = input;
	const existing = kind === "group" ? groups.groups : profiles.profiles;
	let name: string;
	for (;;) {
		const rawName = await ctx.ui.input(`Create ${kind}`, `${kind} name`);
		if (rawName === undefined) return undefined;
		name = rawName.trim();
		const error = newDefinitionNameError(name, existing);
		if (!error) break;
		ctx.ui.notify(error, "warning");
	}
	const globalSkills = sortedNames(
		input.skills.filter((skill) => skill.scope === "user" || skill.scope === "temporary").map((skill) => skill.name),
	);
	if (kind === "group") {
		const skills = await chooseMany(ctx, `Skills in @${name}`, globalSkills);
		return skills ? { kind, name, skills } : undefined;
	}
	const selectedGroups = await chooseMany(ctx, `Groups in ${name}`, Object.keys(groups.groups));
	if (!selectedGroups) return undefined;
	const skills = await chooseMany(ctx, `Individual skills in ${name}`, globalSkills);
	return skills ? { kind, name, groups: selectedGroups, skills } : undefined;
}
