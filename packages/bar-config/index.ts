import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyBarChanged, registerBarComponent, setupBar } from "@noid/pi-bar/api";

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi");
const SETTINGS_PATH = join(CONFIG_DIR, "settings.json");
const SKILL_MANAGER_PATH = join(CONFIG_DIR, "skill-manager.json");

type ThinkingLevel = "off" | "low" | "medium" | "high" | string;

let currentThinkingLevel: ThinkingLevel = readDefaultThinkingLevel();

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function readDefaultThinkingLevel(): ThinkingLevel {
	const settings = readJson(SETTINGS_PATH) as { defaultThinkingLevel?: unknown } | undefined;
	return typeof settings?.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : "off";
}

function latestSessionThinkingLevel(ctx: ExtensionContext): ThinkingLevel | undefined {
	let latest: ThinkingLevel | undefined;
	for (const entry of ctx.sessionManager.getEntries() as readonly unknown[]) {
		const candidate = entry as { type?: unknown; thinkingLevel?: unknown };
		if (candidate.type === "thinking_level_change" && typeof candidate.thinkingLevel === "string")
			latest = candidate.thinkingLevel;
	}
	return latest;
}

function modelSupportsThinking(ctx: ExtensionContext): boolean {
	return Boolean(ctx.model?.reasoning);
}

function formatThinkingLevel(ctx: ExtensionContext) {
	return `${modelSupportsThinking(ctx) ? currentThinkingLevel : "off"}`;
}

function formatSelectedSkillGroup() {
	const state = readJson(SKILL_MANAGER_PATH) as { selectedSkillSet?: unknown } | undefined;
	const selected = state?.selectedSkillSet as { kind?: unknown; groups?: unknown } | undefined;
	if (!selected || selected.kind === "all") return "skills: all";
	if (selected.kind === "none") return "skills: none";
	if (selected.kind === "custom") return "skills: custom";
	if (selected.kind === "groups" && Array.isArray(selected.groups)) {
		const groups = selected.groups.filter((group): group is string => typeof group === "string");
		return groups.length ? `skills: ${groups.map((group) => `@${group}`).join(", ")}` : "skills: none";
	}
	return "skills: all";
}

function refreshThinkingFromSession(ctx: ExtensionContext) {
	currentThinkingLevel = latestSessionThinkingLevel(ctx) ?? readDefaultThinkingLevel();
	notifyBarChanged();
}

export default function barConfigExtension(pi: ExtensionAPI) {
	registerBarComponent("think.level", (context) => formatThinkingLevel(context.ctx));
	registerBarComponent("skill.groups", () => formatSelectedSkillGroup());

	setupBar({
		preset: "default",
		options: {
			sectionStyles: {
				bar_a: "dim",
				bar_b: "dim",
				bar_c: "dim",
				bar_x: "dim",
				bar_y: "dim",
				bar_z: "dim",
			},
		},
		sections: {
			bar_a: ["session"],
			bar_b: ["tokens", "context"],
			bar_c: [],
			bar_x: ["legacy.statuses", "skill.groups"],
			bar_y: ["model"],
			bar_z: ["think.level"],
		},
	});

	pi.on("session_start", async (_event, ctx) => refreshThinkingFromSession(ctx));
	pi.on("model_select", async (_event, _ctx) => notifyBarChanged());
	pi.on("thinking_level_select", async (event, _ctx) => {
		currentThinkingLevel = event.level;
		notifyBarChanged();
	});
}
