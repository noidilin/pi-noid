import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { SkillCatalog } from "./catalog";

export function getSkillManagerCompletions(argumentPrefix: string, _catalog: SkillCatalog): AutocompleteItem[] | null {
	const hasTrailingSpace = /\s$/.test(argumentPrefix);
	const trimmed = argumentPrefix.trim();
	if (hasTrailingSpace || trimmed.includes(" ")) return null;
	if (!"doctor".startsWith(trimmed.toLowerCase())) return null;
	return [{ value: "doctor ", label: "doctor", description: "Validate groups and saved state" }];
}
