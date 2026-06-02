import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createSkillCatalog, type SkillCatalog } from "./catalog";
import { formatEffectiveSkillSet } from "./format";
import { type SkillStateGateway, type SkillTransitionIntent, transitionSkillSelection } from "./state-transition";
import type { SkillItem } from "./types";

export async function showSkillSelector(input: {
	ctx: ExtensionContext;
	catalog: SkillCatalog;
	state: SkillStateGateway;
}) {
	const { ctx, catalog, state } = input;
	const memberships = catalog.memberships;
	if (catalog.skills.length === 0) {
		ctx.ui.notify("No skills discovered.", "warning");
		return;
	}

	await ctx.ui.custom((tui, theme, _kb, done) => {
		type Pane = "groups" | "skills";
		let activePane: Pane = "groups";
		let groupIndex = 0;
		let skillIndex = 0;
		let search = "";
		let searchMode = false;
		let message = "";
		const allSkillNames = catalog.skills.map((skill) => skill.name);

		function pad(text: string, width: number) {
			const truncated = truncateToWidth(text, width, "…");
			return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
		}
		function framed(left: string, right = "", width: number) {
			const inner = Math.max(0, width - 2);
			const content = right
				? `${left}${" ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(right)))}${right}`
				: left;
			return theme.fg("border", "│") + pad(content, inner) + theme.fg("border", "│");
		}
		function divider(width: number, left = "├", fill = "─", right = "┤") {
			return theme.fg("border", `${left}${fill.repeat(Math.max(0, width - 2))}${right}`);
		}
		function disabledSkills() {
			return state.current().disabledSkills;
		}
		function currentCatalog() {
			return createSkillCatalog({
				skills: catalog.skills,
				groupsConfig: catalog.groups,
				disabledSkills: disabledSkills(),
			});
		}
		function currentGroupRows() {
			return currentCatalog().groupRows;
		}
		function filteredGroups() {
			const q = search.toLowerCase();
			const rows = currentGroupRows();
			if (!q) return rows;
			return rows.filter(
				(row) =>
					row.name.toLowerCase().includes(q) ||
					row.discoveredMembers.some((member) => member.toLowerCase().includes(q)),
			);
		}
		function selectedGroupRow() {
			const rows = filteredGroups();
			if (rows.length === 0) return undefined;
			groupIndex = Math.max(0, Math.min(groupIndex, rows.length - 1));
			return rows[groupIndex];
		}
		function filteredSkills() {
			const group = selectedGroupRow();
			const base = group ? group.discoveredMembers : allSkillNames;
			const q = search.toLowerCase();
			return base
				.map((name) => catalog.skillsByName.get(name))
				.filter((skill): skill is SkillItem => Boolean(skill))
				.filter(
					(skill) => !q || skill.name.toLowerCase().includes(q) || skill.description?.toLowerCase().includes(q),
				)
				.sort((a, b) => a.name.localeCompare(b.name));
		}
		function selectedSkill() {
			const rows = filteredSkills();
			if (rows.length === 0) return undefined;
			skillIndex = Math.max(0, Math.min(skillIndex, rows.length - 1));
			return rows[skillIndex];
		}
		function applyIntent(intent: SkillTransitionIntent, successMessage: string) {
			const result = transitionSkillSelection(state.current(), intent, currentCatalog());
			if (!result.ok) {
				message =
					result.reason === "unknown-targets"
						? `Unknown: ${(result.unknownTargets ?? []).join(", ")}`
						: result.reason === "empty-targets"
							? `No discovered skills in: ${(result.emptyTargets ?? []).join(", ")}`
							: "No target selected";
				return;
			}
			state.replace(result.selection);
			void state.saveAndRefresh();
			message = successMessage;
		}
		function toggleSelected() {
			if (activePane === "groups") {
				const group = selectedGroupRow();
				if (!group) return;
				applyIntent(
					{ type: "toggle", targets: [`@${group.name}`] },
					`${group.state === "enabled" ? "Disabled" : "Enabled"} @${group.name}`,
				);
			} else {
				const skill = selectedSkill();
				if (!skill) return;
				applyIntent(
					{ type: "toggle", targets: [skill.name] },
					`${disabledSkills().has(skill.name) ? "Enabled" : "Disabled"} ${skill.name}`,
				);
			}
		}
		function onlySelected() {
			if (activePane === "groups") {
				const group = selectedGroupRow();
				if (!group) return;
				applyIntent({ type: "only", targets: [`@${group.name}`] }, `Enabled only @${group.name}`);
			} else {
				const skill = selectedSkill();
				if (!skill) return;
				applyIntent({ type: "only", targets: [skill.name] }, `Enabled only ${skill.name}`);
			}
		}
		function move(delta: number) {
			if (activePane === "groups")
				groupIndex = Math.max(0, Math.min(groupIndex + delta, Math.max(0, filteredGroups().length - 1)));
			else skillIndex = Math.max(0, Math.min(skillIndex + delta, Math.max(0, filteredSkills().length - 1)));
		}

		return {
			render(width: number) {
				const minWidth = Math.max(40, width);
				const inner = minWidth - 2;
				const enabledCount = allSkillNames.filter((name) => !disabledSkills().has(name)).length;
				const disabledCount = allSkillNames.length - enabledCount;
				const liveCatalog = currentCatalog();
				const current = formatEffectiveSkillSet(liveCatalog.effectiveSkillSet);
				const issues = liveCatalog.issues.length;
				const groupRows = filteredGroups();
				const skillRows = filteredSkills();
				const group = selectedGroupRow();
				const skill = selectedSkill();
				const leftWidth = Math.max(20, Math.floor((inner - 1) * 0.42));
				const rightWidth = inner - leftWidth - 1;
				const listHeight = Math.min(14, Math.max(6, Math.max(groupRows.length, skillRows.length)));
				const lines: string[] = [];
				lines.push(divider(minWidth, "╭", "─", "╮"));
				lines.push(
					framed(
						theme.fg("accent", theme.bold("Skill Manager")),
						issues
							? theme.fg("warning", `⚠ ${issues} issue${issues === 1 ? "" : "s"}`)
							: theme.fg("success", "✓ healthy"),
						minWidth,
					),
				);
				lines.push(
					framed(
						`Active: ${theme.fg("accent", current)}  Enabled: ${enabledCount}/${allSkillNames.length}  Disabled: ${disabledCount}`,
						"",
						minWidth,
					),
				);
				lines.push(
					framed(
						theme.fg(
							searchMode ? "accent" : "dim",
							`Search: ${searchMode ? "▸ " : ""}${search || "(press / to filter)"}`,
						),
						"",
						minWidth,
					),
				);
				lines.push(divider(minWidth));
				const leftTitle = `${activePane === "groups" ? theme.fg("accent", "Groups") : "Groups"}`;
				const rightTitle = `${activePane === "skills" ? theme.fg("accent", group ? `Skills in @${group.name}` : "Skills") : group ? `Skills in @${group.name}` : "Skills"}`;
				lines.push(
					theme.fg("border", "│") +
						pad(` ${leftTitle}`, leftWidth) +
						theme.fg("border", "│") +
						pad(` ${rightTitle}`, rightWidth) +
						theme.fg("border", "│"),
				);
				lines.push(
					theme.fg("border", "├") +
						theme.fg("border", "─".repeat(leftWidth)) +
						theme.fg("border", "┼") +
						theme.fg("border", "─".repeat(rightWidth)) +
						theme.fg("border", "┤"),
				);
				for (let i = 0; i < listHeight; i++) {
					const g = groupRows[i];
					const s = skillRows[i];
					let left = "";
					if (g) {
						const selected = activePane === "groups" && i === groupIndex;
						const icon =
							g.state === "enabled"
								? theme.fg("success", "✓")
								: g.state === "partial"
									? theme.fg("warning", "◐")
									: theme.fg("dim", "○");
						const text = `${selected ? "›" : " "} ${icon} @${g.name} ${g.enabledCount}/${g.totalDiscovered}`;
						left = selected ? theme.fg("accent", text) : g.state === "disabled" ? theme.fg("dim", text) : text;
					}
					let right = "";
					if (s) {
						const selected = activePane === "skills" && i === skillIndex;
						const enabled = !disabledSkills().has(s.name);
						const icon = enabled ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const text = `${selected ? "›" : " "} ${icon} ${s.name}`;
						right = selected ? theme.fg("accent", text) : enabled ? text : theme.fg("dim", text);
					}
					lines.push(
						theme.fg("border", "│") +
							pad(left, leftWidth) +
							theme.fg("border", "│") +
							pad(right, rightWidth) +
							theme.fg("border", "│"),
					);
				}
				lines.push(
					theme.fg("border", "├") +
						theme.fg("border", "─".repeat(leftWidth)) +
						theme.fg("border", "┴") +
						theme.fg("border", "─".repeat(rightWidth)) +
						theme.fg("border", "┤"),
				);
				if (skill) {
					const desc = skill.description ? ` — ${skill.description}` : "";
					const groupsForSkill =
						memberships
							.get(skill.name)
							?.map((name) => `@${name}`)
							.join(" ") ?? "(none)";
					lines.push(
						framed(
							`${!disabledSkills().has(skill.name) ? theme.fg("success", "enabled") : theme.fg("dim", "disabled")} ${theme.fg("accent", skill.name)}${theme.fg("dim", desc)}`,
							"",
							minWidth,
						),
					);
					lines.push(
						framed(
							theme.fg("dim", `Groups: ${groupsForSkill}${skill.path ? `  Path: ${skill.path}` : ""}`),
							"",
							minWidth,
						),
					);
				} else {
					lines.push(framed(theme.fg("dim", "No matching skills."), "", minWidth));
					lines.push(framed("", "", minWidth));
				}
				lines.push(divider(minWidth));
				const help = searchMode
					? "type search • Backspace delete • Enter/Esc finish"
					: "↑↓ move • Tab pane • Space toggle • o only • a all • n none • / search • d doctor • Esc close";
				lines.push(framed(theme.fg("dim", message || help), "", minWidth));
				lines.push(divider(minWidth, "╰", "─", "╯"));
				return lines.map((line) => truncateToWidth(line, width, theme.fg("dim", "…")));
			},
			invalidate() {},
			handleInput(data: string) {
				message = "";
				if (searchMode) {
					if (matchesKey(data, "escape") || matchesKey(data, "return")) searchMode = false;
					else if (data === "\x7f" || data === "\b") search = search.slice(0, -1);
					else if (/^[ -~]$/.test(data)) search += data;
					groupIndex = Math.max(0, Math.min(groupIndex, Math.max(0, filteredGroups().length - 1)));
					skillIndex = Math.max(0, Math.min(skillIndex, Math.max(0, filteredSkills().length - 1)));
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "escape") || data === "q" || data === "Q") done(undefined);
				else if (matchesKey(data, "up")) move(-1);
				else if (matchesKey(data, "down")) move(1);
				else if (matchesKey(data, "tab") || data === "\t")
					activePane = activePane === "groups" ? "skills" : "groups";
				else if (data === "/") searchMode = true;
				else if (data === "c" || data === "C") search = "";
				else if (data === " " || matchesKey(data, "return")) toggleSelected();
				else if (data === "o" || data === "O") onlySelected();
				else if (data === "a" || data === "A") {
					applyIntent({ type: "all" }, "Enabled all skills");
				} else if (data === "n" || data === "N") {
					applyIntent({ type: "none" }, "Disabled all skills");
				} else if (data === "d" || data === "D") {
					message = `Doctor: run /skm doctor for full report (${catalog.issues.length} issue${catalog.issues.length === 1 ? "" : "s"})`;
				}
				tui.requestRender();
			},
		};
	});
}
