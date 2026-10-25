import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Group usage with the model on the right; give the left all remaining space. */
export function layoutStatusBar(width: number, left: string, usage: string, right: string): string {
	if (width <= 0) return "";
	const rhs = truncateToWidth([usage, right].filter(Boolean).join("  "), width);
	const leftBudget = Math.max(0, width - visibleWidth(rhs) - 2);
	const lhs = truncateToWidth(left, leftBudget);
	return lhs + " ".repeat(width - visibleWidth(lhs) - visibleWidth(rhs)) + rhs;
}

export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export default function statusBar(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const settings = SettingsManager.create(ctx.cwd);
		ctx.ui.setFooter((tui, theme, footerData) => ({
			dispose: footerData.onBranchChange(() => tui.requestRender()),
			invalidate() {},
			render(width: number): string[] {
				let cost = 0,
					input = 0,
					output = 0,
					cacheRead = 0,
					cacheWrite = 0;
				let cacheHitRate: number | undefined;
				for (const entry of ctx.sessionManager.getEntries()) {
					// Newer Pi versions also record compaction and nested-tool usage.
					const record = entry as unknown as {
						type: string;
						usage?: {
							input: number;
							output: number;
							cacheRead: number;
							cacheWrite: number;
							cost: { total: number };
						};
						message?: {
							role: string;
							usage?: {
								input: number;
								output: number;
								cacheRead: number;
								cacheWrite: number;
								cost: { total: number };
							};
						};
					};
					const usage = record.type === "message" ? record.message?.usage : record.usage;
					if (!usage) continue;
					cost += usage.cost.total;
					input += usage.input;
					output += usage.output;
					cacheRead += usage.cacheRead;
					cacheWrite += usage.cacheWrite;
					if (record.message?.role === "assistant") {
						const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
						cacheHitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
					}
				}
				const home = homedir();
				const cwd =
					ctx.cwd === home ? "~" : ctx.cwd.startsWith(`${home}/`) ? `~${ctx.cwd.slice(home.length)}` : ctx.cwd;
				const statuses = footerData.getExtensionStatuses();
				const branch = footerData.getGitBranch();
				const sessionName = ctx.sessionManager.getSessionName();
				const pwd = cwd + (branch ? ` (${branch})` : "") + (sessionName ? ` • ${sessionName}` : "");
				const stats: string[] = [];
				if (input) stats.push(`↑${formatTokens(input)}`);
				if (output) stats.push(`↓${formatTokens(output)}`);
				if (cacheRead) stats.push(`R${formatTokens(cacheRead)}`);
				if (cacheWrite) stats.push(`W${formatTokens(cacheWrite)}`);
				if ((cacheRead || cacheWrite) && cacheHitRate !== undefined) stats.push(`CH${cacheHitRate.toFixed(1)}%`);
				const subscription =
					ctx.model && (ctx.model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(ctx.model));
				if (cost || subscription) stats.push(`$${cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
				const context = ctx.getContextUsage();
				const percent = context?.percent === null ? "?" : (context?.percent ?? 0).toFixed(1);
				const auto = settings.getCompactionEnabled() ? " (auto)" : "";
				const contextText = `${percent}${percent === "?" ? "" : "%"}/${formatTokens(context?.contextWindow ?? ctx.model?.contextWindow ?? 0)}${auto}`;
				stats.push(
					(context?.percent ?? 0) > 90
						? theme.fg("error", contextText)
						: (context?.percent ?? 0) > 70
							? theme.fg("warning", contextText)
							: contextText,
				);
				const left = theme.fg("dim", `${pwd}  ${stats.join(" ")}`);
				const middle = theme.fg("dim", stripVTControlCharacters(statuses.get("usage") ?? ""));
				let model = ctx.model?.id ?? "no-model";
				if (ctx.model?.reasoning) {
					const thinking = pi.getThinkingLevel();
					model += ` • ${thinking === "off" ? "thinking off" : thinking}`;
				}
				if (ctx.model && footerData.getAvailableProviderCount() > 1) {
					const withProvider = `(${ctx.model.provider}) ${model}`;
					const rightBudget = width - visibleWidth(left) - visibleWidth(middle) - 4;
					if (visibleWidth(withProvider) <= rightBudget) model = withProvider;
				}
				const right = theme.fg("dim", model);
				const lines = [layoutStatusBar(width, left, middle, right)];
				// Do not hide operational statuses published by other extensions.
				const others = [...statuses].filter(([key]) => key !== "usage").map(([, value]) => value);
				if (others.length) lines.push(truncateToWidth(others.join("  "), width));
				return lines;
			},
		}));
	});
}
