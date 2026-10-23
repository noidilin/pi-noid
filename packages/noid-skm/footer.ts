import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type SkillFooterData = {
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(listener: () => void): () => void;
};

const SETTINGS_PATH = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi", "settings.json");

let currentThinkingLevel = "off";
const refreshListeners = new Set<() => void>();

function defaultThinkingLevel(): string {
	try {
		const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as { defaultThinkingLevel?: unknown };
		return typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : "off";
	} catch {
		return "off";
	}
}

function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function sanitize(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function tokenSummary(ctx: ExtensionContext): string {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant" || !entry.message.usage) continue;
		input += entry.message.usage.input ?? 0;
		output += entry.message.usage.output ?? 0;
		cacheRead += entry.message.usage.cacheRead ?? 0;
		cacheWrite += entry.message.usage.cacheWrite ?? 0;
		cost += entry.message.usage.cost?.total ?? 0;
	}

	const parts: string[] = [];
	if (input) parts.push(`↑${formatTokens(input)}`);
	if (output) parts.push(`↓${formatTokens(output)}`);
	if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
	if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
	const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	if (cost || usingSubscription) parts.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
	return parts.join(" ");
}

function contextSummary(ctx: ExtensionContext, theme: Theme): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const percent = usage?.percent;
	const text =
		percent === null || percent === undefined
			? `?/${formatTokens(contextWindow)}`
			: `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
	if (percent !== null && percent !== undefined && percent > 90) return theme.fg("error", text);
	if (percent !== null && percent !== undefined && percent > 70) return theme.fg("warning", text);
	return text;
}

function modelSummary(ctx: ExtensionContext, footerData: SkillFooterData): string {
	if (!ctx.model) return "no-model";
	return footerData.getAvailableProviderCount() > 1 ? `(${ctx.model.provider}) ${ctx.model.id}` : ctx.model.id;
}

function statusSummary(footerData: SkillFooterData): string {
	return Array.from(footerData.getExtensionStatuses().entries())
		.filter(([key]) => key !== "skill-manager")
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, text]) => sanitize(text))
		.filter(Boolean)
		.join("  ");
}

function joinParts(parts: Array<string | undefined>): string {
	return parts
		.map((part) => sanitize(part ?? ""))
		.filter(Boolean)
		.join("  ");
}

export function joinFooterSides(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (!right) return truncateToWidth(left, width, "...");
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, "...");
	const gap = Math.max(1, width - visibleWidth(left) - rightWidth);
	if (gap > 1) return `${left}${" ".repeat(gap)}${right}`;
	const leftWidth = Math.max(0, width - rightWidth - 1);
	return `${truncateToWidth(left, leftWidth, "...")} ${right}`;
}

export function renderSkillFooterLine(input: {
	ctx: ExtensionContext;
	theme: Theme;
	footerData: SkillFooterData;
	width: number;
	skillStatus: string;
}): string {
	const { ctx, theme, footerData, width, skillStatus } = input;
	const left = joinParts([ctx.sessionManager.getSessionName(), tokenSummary(ctx), contextSummary(ctx, theme)]);
	const right = joinParts([
		statusSummary(footerData),
		skillStatus,
		modelSummary(ctx, footerData),
		ctx.model?.reasoning ? currentThinkingLevel : "off",
	]);
	return joinFooterSides(theme.fg("dim", left), theme.fg("dim", right), width);
}

export function setSkillFooterThinkingLevel(level: string): void {
	currentThinkingLevel = level;
	requestSkillFooterRender();
}

export function refreshSkillFooterThinkingLevel(ctx: ExtensionContext): void {
	let latest: string | undefined;
	for (const entry of ctx.sessionManager.getEntries() as readonly unknown[]) {
		const candidate = entry as { type?: unknown; thinkingLevel?: unknown };
		if (candidate.type === "thinking_level_change" && typeof candidate.thinkingLevel === "string") {
			latest = candidate.thinkingLevel;
		}
	}
	currentThinkingLevel = latest ?? defaultThinkingLevel();
}

export function requestSkillFooterRender(): void {
	for (const listener of refreshListeners) listener();
}

export function installSkillManagerFooter(ctx: ExtensionContext, getSkillStatus: () => string): void {
	if (!ctx.hasUI) return;
	ctx.ui.setFooter((tui, theme, footerData) => {
		const requestRender = () => tui.requestRender();
		const unsubscribeBranch = footerData.onBranchChange(requestRender);
		refreshListeners.add(requestRender);
		const timer = setInterval(requestRender, 1_000);
		return {
			dispose() {
				unsubscribeBranch();
				refreshListeners.delete(requestRender);
				clearInterval(timer);
			},
			invalidate() {},
			render(width: number): string[] {
				return [renderSkillFooterLine({ ctx, theme, footerData, width, skillStatus: getSkillStatus() })];
			},
		};
	});
}
