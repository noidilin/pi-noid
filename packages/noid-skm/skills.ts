import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { SkillItem } from "./types";

export function getSkillItems(pi: ExtensionAPI): SkillItem[] {
	return pi
		.getCommands()
		.filter((command): command is SlashCommandInfo & { source: "skill" } => command.source === "skill")
		.map((command) => ({
			name: command.name.replace(/^skill:/, ""),
			description: command.description,
			path: command.sourceInfo.path,
			scope: command.sourceInfo.scope,
		}));
}
