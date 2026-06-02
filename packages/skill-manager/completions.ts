import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { SkillCatalog } from "./catalog";

export function getSkillManagerCompletions(argumentPrefix: string, catalog: SkillCatalog): AutocompleteItem[] | null {
	const actions: AutocompleteItem[] = [
		{ value: "list ", label: "list", description: "Show enabled and disabled skills" },
		{ value: "groups ", label: "groups", description: "Show configured @groups" },
		{ value: "doctor ", label: "doctor", description: "Validate groups and saved state" },
		{ value: "all ", label: "all", description: "Enable all skills" },
		{ value: "none ", label: "none", description: "Disable all discovered skills" },
		{ value: "enable ", label: "enable", description: "Enable skills or @groups" },
		{ value: "disable ", label: "disable", description: "Disable skills or @groups" },
		{ value: "only ", label: "only", description: "Enable only skills or @groups" },
	];
	const hasTrailingSpace = /\s$/.test(argumentPrefix);
	const trimmed = argumentPrefix.trim();
	const parts = trimmed ? trimmed.split(/\s+/) : [];
	if (parts.length === 0 || (parts.length === 1 && !hasTrailingSpace)) {
		const prefix = parts[0]?.toLowerCase() ?? "";
		const matches = actions.filter((item) => item.label.toLowerCase().startsWith(prefix));
		return matches.length > 0 ? matches : null;
	}

	const action = parts[0]?.toLowerCase();
	if (action === "list") {
		if (parts.includes("--groups")) return null;
		return [{ value: "list --groups", label: "--groups", description: "Include @group membership" }];
	}
	if (!["enable", "disable", "only"].includes(action ?? "")) return null;

	const completedTargets = hasTrailingSpace ? parts.slice(1) : parts.slice(1, -1);
	const currentPrefix = hasTrailingSpace ? "" : (parts.at(-1) ?? "");
	const groupItems = catalog.groupRows.map((group) => ({
		value: `@${group.name}`,
		label: `@${group.name}`,
		description: `${group.totalDiscovered} skills`,
	}));
	const skillItems = catalog.skills.map((skill) => ({
		value: skill.name,
		label: skill.name,
		description: skill.description,
	}));
	const existing = new Set(completedTargets);
	const candidates = [...groupItems, ...skillItems]
		.filter((item) => !existing.has(item.value))
		.filter((item) => item.value.toLowerCase().startsWith(currentPrefix.toLowerCase()))
		.map((item) => ({
			value: `${action} ${[...completedTargets, item.value].join(" ")} `,
			label: item.label,
			description: item.description,
		}));
	return candidates.length > 0 ? candidates : null;
}
