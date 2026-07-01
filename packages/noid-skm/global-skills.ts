import { homedir } from "node:os";
import { normalize, sep } from "node:path";
import type { SkillItem } from "./types";

export function getGlobalAgentSkills(skills: SkillItem[]) {
	return skills.filter(isGlobalAgentSkill).sort((a, b) => a.name.localeCompare(b.name));
}

function isGlobalAgentSkill(skill: SkillItem) {
	if (!skill.path) return false;
	const path = normalize(skill.path);
	const home = normalize(homedir());
	const globalRoots = [
		normalize(`${home}/.agents/skills`),
		normalize(`${home}/.agent/skills`),
		normalize(`${home}/.pi/agent/skills`),
	];
	return globalRoots.some((root) => path === root || path.startsWith(`${root}${sep}`));
}
