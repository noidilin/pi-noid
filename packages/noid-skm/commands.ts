import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SkillCatalog } from "./catalog";
import { formatDoctorReport } from "./doctor";
import { formatEffectiveSkillSet } from "./format";
import { GROUPS_PATH } from "./paths";
import {
	type SkillStateGateway,
	type SkillTransitionIntent,
	type SkillTransitionResult,
	transitionSkillSelection,
} from "./state-transition";

export async function handleSkillManagerCommand(input: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	args: string;
	catalog: SkillCatalog;
	state: SkillStateGateway;
	showSelector: () => Promise<void>;
}) {
	const { pi, ctx, args, catalog, state, showSelector } = input;
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const action = parts[0]?.toLowerCase();
	const names = parts.slice(1);

	if (!action) return showSelector();

	if (action === "list") {
		const showGroups = names.includes("--groups") || names.includes("groups");
		const lines = [
			`Skills: ${catalog.enabledSkillNames.length} enabled, ${catalog.disabledSkillNames.length} disabled`,
			`Current: ${formatEffectiveSkillSet(catalog.effectiveSkillSet)}`,
			"",
			"Enabled:",
			...(catalog.enabledSkillNames.length ? catalog.enabledSkillNames.map((name) => `  ${name}`) : ["  (none)"]),
			"",
			"Disabled:",
			...(catalog.disabledSkillNames.length ? catalog.disabledSkillNames.map((name) => `  ${name}`) : ["  (none)"]),
		];
		if (showGroups) appendGroups(lines, catalog);
		pi.sendMessage({ customType: "skill-manager-list", content: lines.join("\n"), display: true });
		return;
	}

	if (action === "groups") {
		const lines = [`Groups from ${GROUPS_PATH}:`];
		if (catalog.groupRows.length === 0) lines.push("  (none; create skill-manager-groups.json to define @groups)");
		else
			for (const group of catalog.groupRows)
				lines.push(`  @${group.name}: ${group.stringMembers.join(", ") || "(none)"}`);
		pi.sendMessage({ customType: "skill-manager-list", content: lines.join("\n"), display: true });
		return;
	}

	if (action === "doctor") {
		pi.sendMessage({ customType: "skill-manager-doctor", content: formatDoctorReport(catalog), display: true });
		return;
	}

	const intent = commandIntent(action, names);
	if (!intent) {
		ctx.ui.notify("Usage: /skm [list|list --groups|groups|doctor|all|none|enable|disable|only]", "warning");
		return;
	}

	const result = transitionSkillSelection(state.current(), intent, catalog);
	if (!result.ok) {
		ctx.ui.notify(formatTransitionError(action, result), "warning");
		return;
	}

	state.replace(result.selection);
	await state.saveAndRefresh();
	ctx.ui.notify(formatTransitionSuccess(result), "info");
}

function commandIntent(action: string, names: string[]): SkillTransitionIntent | undefined {
	if (action === "all") return { type: "all" };
	if (action === "none") return { type: "none" };
	if (action === "enable" || action === "disable" || action === "only") return { type: action, targets: names };
	return undefined;
}

function formatTransitionError(action: string, result: Extract<SkillTransitionResult, { ok: false }>) {
	if (result.reason === "missing-targets") return `Usage: /skm ${action} <skill-name|@group> [skill-name|@group...]`;
	if (result.reason === "unknown-targets")
		return `Unknown skill/group(s): ${(result.unknownTargets ?? []).join(", ")}`;
	return `No discovered skills in: ${(result.emptyTargets ?? []).join(", ")}`;
}

function formatTransitionSuccess(result: Extract<SkillTransitionResult, { ok: true }>) {
	if (result.event === "all-enabled") return "All skills enabled.";
	if (result.event === "none-enabled") return "All discovered skills disabled.";
	return `Updated skill manager. Disabled: ${result.selection.disabledSkills.size}`;
}

function appendGroups(lines: string[], catalog: SkillCatalog) {
	lines.push("", `Groups from ${GROUPS_PATH}:`);
	if (catalog.groupRows.length === 0) {
		lines.push("  (none; create skill-manager-groups.json to define @groups)");
		return;
	}
	for (const group of catalog.groupRows) {
		lines.push(`  @${group.name}:`);
		for (const member of group.stringMembers)
			lines.push(`    ${member} (${catalog.persistedDisabledSkillNames.includes(member) ? "disabled" : "enabled"})`);
	}
}
