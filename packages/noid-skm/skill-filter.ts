import type { Skill } from "@earendil-works/pi-coding-agent";

export function filterSkills(
	skills: readonly Skill[],
	allowed: ReadonlySet<string>,
): { skills: Skill[]; diagnostics: string[] } {
	const diagnostics: string[] = [];
	return {
		skills: skills.filter((skill) => {
			const scope = skill.sourceInfo?.scope;
			if (scope === "project") return true;
			if (scope === "user" || scope === "temporary") return allowed.has(skill.name);
			diagnostics.push(`Unclassified skill scope: ${skill.name}`);
			return true;
		}),
		diagnostics,
	};
}
