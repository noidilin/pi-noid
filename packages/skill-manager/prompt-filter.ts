import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

export function applySkillFilter(
	systemPrompt: string,
	skills: Skill[],
	disabledSkills: ReadonlySet<string>,
): { systemPrompt: string; changed: boolean } {
	const enabledSkills = skills.filter((skill) => !disabledSkills.has(skill.name));
	const originalBlock = formatSkillsForPrompt(skills);
	const filteredBlock = formatSkillsForPrompt(enabledSkills);

	if (originalBlock && systemPrompt.includes(originalBlock)) {
		return { systemPrompt: systemPrompt.replace(originalBlock, filteredBlock), changed: true };
	}

	const skillsBlockPattern =
		/\n*The following skills provide specialized instructions for specific tasks\.[\s\S]*?\n<available_skills>\n[\s\S]*?\n<\/available_skills>/;
	if (skillsBlockPattern.test(systemPrompt)) {
		const replacement = filteredBlock ? `\n${filteredBlock.trimStart()}` : "";
		return { systemPrompt: systemPrompt.replace(skillsBlockPattern, replacement), changed: true };
	}

	return { systemPrompt, changed: false };
}
