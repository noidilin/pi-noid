import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Keep usage truly centered; truncate the outer sections before they overlap. */
export function layoutStatusBar(width: number, left: string, middle: string, right: string): string {
	if (width <= 0) return "";
	const center = truncateToWidth(middle, Math.floor(width / 2));
	const centerWidth = visibleWidth(center);
	const centerStart = Math.floor((width - centerWidth) / 2);
	const leftBudget = Math.max(0, centerStart - (centerWidth ? 1 : 0));
	const rightStart = centerStart + centerWidth;
	const rightBudget = Math.max(0, width - rightStart - (centerWidth ? 1 : 0));
	const lhs = truncateToWidth(left, leftBudget);
	const rhs = truncateToWidth(right, rightBudget);
	return (
		lhs +
		" ".repeat(centerStart - visibleWidth(lhs)) +
		center +
		" ".repeat(width - rightStart - visibleWidth(rhs)) +
		rhs
	);
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

export default function statusBar(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((_tui, theme, footerData) => ({
			invalidate() {},
			render(width: number): string[] {
				let cost = 0;
				let tokens = 0;
				// Match Pi's cumulative session totals, including cached tokens and compactions.
				for (const entry of ctx.sessionManager.getEntries()) {
					if (entry.type !== "message" || entry.message.role !== "assistant") continue;
					const usage = entry.message.usage;
					cost += usage.cost.total;
					tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
				}
				const home = homedir();
				const cwd =
					ctx.cwd === home ? "~" : ctx.cwd.startsWith(`${home}/`) ? `~${ctx.cwd.slice(home.length)}` : ctx.cwd;
				const statuses = footerData.getExtensionStatuses();
				const left = theme.fg("dim", `${cwd}  $${cost.toFixed(3)} (${formatTokens(tokens)} tokens)`);
				const middle = statuses.get("usage") ?? "";
				const right = theme.fg("dim", `${ctx.model?.id ?? "no-model"} · ${pi.getThinkingLevel()}`);
				const lines = [layoutStatusBar(width, left, middle, right)];
				// Do not hide operational statuses published by other extensions.
				const others = [...statuses].filter(([key]) => key !== "usage").map(([, value]) => value);
				if (others.length) lines.push(truncateToWidth(others.join("  "), width));
				return lines;
			},
		}));
	});
}
