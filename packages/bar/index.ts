import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BarPresetName, type BarSectionName, getBarConfig, setBarPreset, subscribeBarChanges } from "./api";
import { markBarSessionStarted, renderBarLine } from "./render-pipeline";

function installBar(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	markBarSessionStarted(ctx);
	ctx.ui.setFooter((tui, theme, footerData) => {
		const requestRender = () => tui.requestRender();
		const unsubBranch = footerData.onBranchChange(requestRender);
		const unsubBar = subscribeBarChanges(requestRender);
		const timer = setInterval(requestRender, 1000);
		return {
			dispose() {
				unsubBranch();
				unsubBar();
				clearInterval(timer);
			},
			invalidate() {},
			render(width: number): string[] {
				return [renderBarLine({ ctx, theme, footerData, width, requestRender })];
			},
		};
	});
}

const PRESET_NAMES = ["default", "minimal", "powerline", "diagnostic", "verbose"] as const;

function isBarPresetName(value: string): value is BarPresetName {
	return (PRESET_NAMES as readonly string[]).includes(value);
}

function configSummary(enabled: boolean) {
	const config = getBarConfig();
	const sections = (["bar_a", "bar_b", "bar_c", "bar_x", "bar_y", "bar_z"] as BarSectionName[])
		.map((section) => `${section}: ${config.sections?.[section]?.length ?? 0}`)
		.join(", ");
	return `Bar ${enabled ? "enabled" : "disabled"}. Sections: ${sections}`;
}

export default function barExtension(pi: ExtensionAPI) {
	let enabled = true;
	pi.registerCommand("bar", {
		description: "Manage compact lualine-style status bar",
		argumentHint: "[on|off|status|reload|preset <name>]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const action = (parts[0] ?? "on").toLowerCase();
			const value = parts[1]?.toLowerCase();

			if (action === "off" || action === "builtin") {
				enabled = false;
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Restored built-in footer.", "info");
				return;
			}
			if (action === "on" || action === "compact") {
				enabled = true;
				installBar(ctx);
				ctx.ui.notify("Bar enabled.", "info");
				return;
			}
			if (action === "status") {
				ctx.ui.notify(configSummary(enabled), "info");
				return;
			}
			if (action === "reload") {
				await ctx.reload();
				return;
			}
			if (action === "preset" || isBarPresetName(action)) {
				const preset = action === "preset" ? value : action;
				if (!preset || !isBarPresetName(preset)) {
					ctx.ui.notify(`Usage: /bar preset ${PRESET_NAMES.join("|")}`, "warning");
					return;
				}
				setBarPreset(preset);
				enabled = true;
				installBar(ctx);
				ctx.ui.notify(`Bar preset: ${preset}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /bar [on|off|status|reload|preset <name>]", "warning");
		},
	} as any);
	pi.on("session_start", async (_event, ctx) => {
		if (enabled) installBar(ctx);
	});
}
