import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyBarChanged, registerBarModule } from "noid-bar/api";
import { createSkillCatalog } from "./catalog";
import { handleSkillManagerCommand } from "./commands";
import { getSkillManagerCompletions } from "./completions";
import { formatEffectiveSkillSet } from "./format";
import { SkillGroupsStore } from "./groups-store";
import { applySkillFilter } from "./prompt-filter";
import { getSkillItems } from "./skills";
import { SkillManagerStateStore } from "./state-store";
import { normalizeSelection, type SkillManagerSelection } from "./state-transition";
import { showSkillSelector } from "./tui";

let skillManagerStatusText = "skills: loading";

export const skillManagerBar = {
	name: "skill-manager",
	components: {
		status: () => skillManagerStatusText,
	},
};

export default function skillManagerExtension(pi: ExtensionAPI) {
	const state = new SkillManagerStateStore(pi);
	const groupsStore = new SkillGroupsStore();
	let promptFilterWarned = false;

	registerBarModule({
		key: "skill-manager",
		priority: 20,
		render: () => skillManagerStatusText,
	});

	async function getCatalog() {
		const groupsSnapshot = await groupsStore.load();
		const stateSnapshot = state.snapshot();
		return createSkillCatalog({
			skills: getSkillItems(pi),
			groupsConfig: groupsSnapshot.groups,
			disabledSkills: stateSnapshot.disabledSkills,
			selectedSkillSet: stateSnapshot.selectedSkillSet,
			storeIssues: [...stateSnapshot.issues, ...groupsSnapshot.issues],
		});
	}

	async function updateStatus(ctx: ExtensionContext) {
		const catalog = await getCatalog();
		const suffix = catalog.disabledSkillNames.length > 0 ? ` (-${catalog.disabledSkillNames.length})` : "";
		const warning = catalog.issues.some(
			(issue) => issue.kind === "state-load-error" || issue.kind === "groups-load-error",
		)
			? " ⚠"
			: "";
		const projectSuffix = catalog.protectedProjectSkillNames.length > 0 ? ` +${catalog.protectedProjectSkillNames.length}p` : "";
		skillManagerStatusText = `skills: ${formatEffectiveSkillSet(catalog.effectiveSkillSet)}${suffix}${projectSuffix}${warning}`;
		ctx.ui.setStatus("skill-manager", undefined);
		notifyBarChanged();
	}

	async function saveAndRefresh(ctx: ExtensionContext) {
		await state.queueSave(ctx);
		await updateStatus(ctx);
	}

	async function saveGroupsAndRefresh(groups: Record<string, string[]>, ctx: ExtensionContext) {
		await groupsStore.save(groups);
		await updateStatus(ctx);
	}

	function stateGateway(ctx: ExtensionContext, catalog: Awaited<ReturnType<typeof getCatalog>>) {
		return {
			current: () => normalizeSelection(state.getSelection(), catalog),
			replace: (selection: SkillManagerSelection) => state.setSelection(selection),
			saveAndRefresh: () => saveAndRefresh(ctx),
		};
	}

	async function showSelector(ctx: ExtensionContext) {
		const catalog = await getCatalog();
		await showSkillSelector({
			ctx,
			catalog,
			state: stateGateway(ctx, catalog),
			saveGroups: (groups) => saveGroupsAndRefresh(groups, ctx),
		});
	}

	pi.registerCommand("skm", {
		description: "Manage skills loaded into model context",
		argumentHint: "[doctor]",
		getArgumentCompletions: async (argumentPrefix: string) => {
			await state.load();
			return getSkillManagerCompletions(argumentPrefix, await getCatalog());
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			await state.load();
			const catalog = await getCatalog();
			await handleSkillManagerCommand({
				pi,
				ctx,
				args,
				catalog,
				showSelector: () => showSelector(ctx),
			});
		},
	} as any);

	pi.on("session_start", async (_event, ctx) => {
		await state.load();
		await updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const stateSnapshot = await state.load();
		const skills = event.systemPromptOptions.skills ?? [];
		await updateStatus(ctx);
		if (stateSnapshot.disabledSkills.size === 0 || skills.length === 0) return;
		const catalog = await getCatalog();
		const effectiveDisabledSkills = new Set(
			Array.from(stateSnapshot.disabledSkills).filter((name) => !catalog.protectedProjectSkillNames.includes(name)),
		);
		if (effectiveDisabledSkills.size === 0) return;
		const result = applySkillFilter(event.systemPrompt, skills, effectiveDisabledSkills);
		if (!result.changed && !promptFilterWarned) {
			promptFilterWarned = true;
			ctx.ui.notify(
				"Skill Manager could not locate the skills block; disabled skills may still be visible this turn.",
				"warning",
			);
		}
		return result.changed ? { systemPrompt: result.systemPrompt } : undefined;
	});

	pi.on("input", async (event, ctx) => {
		const stateSnapshot = await state.load();
		const match = event.text.match(/(?:^|\s)\/skill:([^\s]+)\b/);
		if (!match) return { action: "continue" as const };
		const skillName = match[1];
		const catalog = await getCatalog();
		if (catalog.protectedProjectSkillNames.includes(skillName)) return { action: "continue" as const };
		if (!stateSnapshot.disabledSkills.has(skillName)) return { action: "continue" as const };
		ctx.ui.notify(`Skill disabled: ${skillName}. Re-enable it from /skm.`, "warning");
		return { action: "handled" as const };
	});
}
