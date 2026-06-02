import type { SkillCatalog } from "./catalog";
import { formatEffectiveSkillSet, formatIssue } from "./format";
import { GROUPS_PATH, STATE_PATH } from "./paths";

export function formatDoctorReport(catalog: SkillCatalog) {
	const lines = [
		"Skill Manager Doctor",
		"",
		`State: ${STATE_PATH}`,
		`Groups: ${GROUPS_PATH}`,
		`Discovered skills: ${catalog.skills.length}`,
		`Effective group: ${formatEffectiveSkillSet(catalog.effectiveSkillSet)}`,
		`Effective enabled: ${catalog.enabledSkillNames.length ? catalog.enabledSkillNames.join(", ") : "(none)"}`,
		`Effective disabled: ${catalog.disabledSkillNames.length ? catalog.disabledSkillNames.join(", ") : "(none)"}`,
		"",
	];
	if (catalog.issues.length === 0) lines.push("No issues found.");
	else lines.push(`Issues: ${catalog.issues.length}`, ...catalog.issues.map((issue) => `  - ${formatIssue(issue)}`));
	return lines.join("\n");
}
