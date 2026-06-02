import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BarComponentFn,
	type BarComponentOptions,
	type BarComponentSpec,
	type BarRenderContext,
	type BarSectionName,
	type BarSectionStyle,
	getBarComponent,
	getBarConfig,
	getBarModules,
} from "./api";

export type BarBaseRenderContext = Omit<BarRenderContext, "section">;

const LEFT_SECTIONS: BarSectionName[] = ["bar_a", "bar_b", "bar_c"];
const RIGHT_SECTIONS: BarSectionName[] = ["bar_x", "bar_y", "bar_z"];

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function extractAnsiCode(text: string, pos: number) {
	if (text[pos] !== "\u001b") return undefined;
	const next = text[pos + 1];
	if (next === "[") {
		let end = pos + 2;
		while (end < text.length && !/[A-Za-z]/.test(text[end]!)) end++;
		return end < text.length ? text.slice(pos, end + 1) : undefined;
	}
	if (next === "]" || next === "_") {
		let end = pos + 2;
		while (end < text.length) {
			if (text[end] === "\u0007") return text.slice(pos, end + 1);
			if (text[end] === "\u001b" && text[end + 1] === "\\") return text.slice(pos, end + 2);
			end++;
		}
	}
	return undefined;
}

function stripAnsi(text: string) {
	let result = "";
	for (let index = 0; index < text.length; ) {
		const ansi = extractAnsiCode(text, index);
		if (ansi) {
			index += ansi.length;
			continue;
		}
		result += text[index]!;
		index++;
	}
	return result;
}

function graphemeWidth(segment: string) {
	if (!segment) return 0;
	if (/^[\p{Mark}\p{Control}\p{Default_Ignorable_Code_Point}]+$/u.test(segment)) return 0;
	const cp = segment.codePointAt(0) ?? 0;
	if (segment.includes("\uFE0F") || segment.includes("\u200D") || (cp >= 0x1f000 && cp <= 0x1fbff)) return 2;
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		cp === 0x2329 ||
		cp === 0x232a ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe10 && cp <= 0xfe19) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6)
	)
		return 2;
	return 1;
}

function visibleWidth(text: string) {
	let width = 0;
	for (const { segment } of segmenter.segment(stripAnsi(text).replace(/\t/g, "   "))) width += graphemeWidth(segment);
	return width;
}

function truncatePlainToWidth(text: string, width: number) {
	let result = "";
	let used = 0;
	for (const { segment } of segmenter.segment(stripAnsi(text))) {
		const next = graphemeWidth(segment);
		if (used + next > width) break;
		result += segment;
		used += next;
	}
	return result;
}

function truncateToWidth(text: string, width: number, ellipsis = "...") {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const ellipsisWidth = visibleWidth(ellipsis);
	if (width <= ellipsisWidth) return truncatePlainToWidth(ellipsis, width);

	const target = width - ellipsisWidth;
	let result = "";
	let used = 0;
	let sawAnsi = false;
	for (let index = 0; index < text.length; ) {
		const ansi = extractAnsiCode(text, index);
		if (ansi) {
			sawAnsi = true;
			result += ansi;
			index += ansi.length;
			continue;
		}
		const nextAnsi = text.indexOf("\u001b", index);
		const chunkEnd = nextAnsi === -1 ? text.length : nextAnsi;
		for (const { segment } of segmenter.segment(text.slice(index, chunkEnd))) {
			const next = graphemeWidth(segment);
			if (used + next > target) return `${result}${sawAnsi ? "\u001b[0m" : ""}${ellipsis}`;
			result += segment;
			used += next;
		}
		index = chunkEnd;
	}
	return result;
}

function sanitize(text: string) {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number) {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

const tokenCache = new WeakMap<ExtensionContext, { entries: readonly unknown[]; length: number; text: string }>();
const sessionStartedAt = new WeakMap<ExtensionContext, number>();
const asyncCache = new Map<string, { value?: string; updatedAt: number; pending?: Promise<void> }>();
const functionCacheIds = new WeakMap<BarComponentFn, string>();
let nextFunctionCacheId = 1;

export function markBarSessionStarted(ctx: ExtensionContext, now = Date.now()) {
	sessionStartedAt.set(ctx, sessionStartedAt.get(ctx) ?? now);
}

export function resetBarRenderPipelineForTests() {
	asyncCache.clear();
	reportedComponentErrors.clear();
}

function tokenParts(ctx: ExtensionContext) {
	const entries = ctx.sessionManager.getEntries();
	const cached = tokenCache.get(ctx);
	if (cached && cached.entries === entries && cached.length === entries.length) return cached.text;

	let input = 0,
		output = 0,
		cacheRead = 0,
		cacheWrite = 0,
		cost = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		if (!usage) continue;
		input += usage.input ?? 0;
		output += usage.output ?? 0;
		cacheRead += usage.cacheRead ?? 0;
		cacheWrite += usage.cacheWrite ?? 0;
		cost += usage.cost?.total ?? 0;
	}
	const parts: string[] = [];
	if (input) parts.push(`↑${formatTokens(input)}`);
	if (output) parts.push(`↓${formatTokens(output)}`);
	if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
	if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
	const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	if (cost || usingSubscription) parts.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
	const text = parts.join(" ");
	tokenCache.set(ctx, { entries, length: entries.length, text });
	return text;
}

function pwd(ctx: ExtensionContext) {
	let value = ctx.sessionManager.getCwd();
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && value.startsWith(home)) value = `~${value.slice(home.length)}`;
	return value;
}

function formatDuration(ms: number) {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	if (hours) return `${hours}h${minutes.toString().padStart(2, "0")}m`;
	if (minutes) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	return `${seconds}s`;
}

function entryTime(entry: unknown) {
	const candidate = entry as { timestamp?: unknown; message?: { timestamp?: unknown } };
	const value = candidate.timestamp ?? candidate.message?.timestamp;
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function lastResponseTime(ctx: ExtensionContext) {
	let latest: number | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		latest = Math.max(latest ?? 0, entryTime(entry) ?? 0);
	}
	return latest ? formatDuration(Date.now() - latest) : undefined;
}

function renderBuiltin(name: string, context: BarRenderContext) {
	const { ctx, footerData, theme } = context;
	switch (name) {
		case "pwd":
			return pwd(ctx);
		case "branch":
			return footerData.getGitBranch() ? `(${footerData.getGitBranch()})` : undefined;
		case "session":
			return ctx.sessionManager.getSessionName();
		case "tokens":
			return tokenParts(ctx);
		case "session.time":
			return formatDuration(Date.now() - (sessionStartedAt.get(ctx) ?? Date.now()));
		case "last_response.time":
			return lastResponseTime(ctx);
		case "context": {
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const percent = usage?.percent ?? 0;
			const text =
				usage?.percent === null || usage?.percent === undefined
					? `?/${formatTokens(contextWindow)}`
					: `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
			return percent > 90 ? theme.fg("error", text) : percent > 70 ? theme.fg("warning", text) : text;
		}
		case "model": {
			if (!ctx.model) return "no-model";
			return footerData.getAvailableProviderCount() > 1 ? `(${ctx.model.provider}) ${ctx.model.id}` : ctx.model.id;
		}
		case "legacy.statuses": {
			const modern = getBarModules()
				.map((module) => module.render(ctx))
				.filter((text): text is string => Boolean(text));
			const legacy = Array.from(footerData.getExtensionStatuses().entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => text);
			return [...modern, ...legacy].map(sanitize).filter(Boolean).join("  ");
		}
		default:
			return undefined;
	}
}

function normalizeSpec(spec: BarComponentSpec): {
	component: string | ((context: BarRenderContext) => string | undefined | Promise<string | undefined>);
	options: BarComponentOptions;
} {
	if (Array.isArray(spec)) return { component: spec[0], options: spec[1] ?? {} };
	if (typeof spec === "object" && "component" in spec) {
		const { component, ...options } = spec;
		return { component, options };
	}
	return { component: spec, options: {} };
}

function padding(options: BarComponentOptions) {
	if (typeof options.padding === "number") return { left: options.padding, right: options.padding };
	return { left: options.padding?.left ?? 0, right: options.padding?.right ?? 0 };
}

function componentSeparator(options: BarComponentOptions, section: BarSectionName) {
	const side = section <= "bar_c" ? "left" : "right";
	const configured = getBarConfig().options.componentSeparators;
	const fallback = typeof configured === "string" ? configured : (configured[side] ?? " ");
	const separator = options.separator ?? fallback;
	return typeof separator === "string" ? separator : (separator[side] ?? fallback);
}

const reportedComponentErrors = new Set<string>();

function componentLabel(
	component: string | ((context: BarRenderContext) => string | undefined | Promise<string | undefined>),
) {
	return typeof component === "string" ? component : "<function>";
}

function reportComponentError(
	component: string | ((context: BarRenderContext) => string | undefined | Promise<string | undefined>),
	context: BarRenderContext,
	error: unknown,
) {
	const label = componentLabel(component);
	if (reportedComponentErrors.has(label)) return;
	reportedComponentErrors.add(label);
	const message = error instanceof Error ? error.message : String(error);
	context.ctx.ui.notify(`Bar component ${label} failed: ${message}`, "warning");
}

function cacheKey(
	component: string | ((context: BarRenderContext) => string | undefined | Promise<string | undefined>),
	stack: string[],
) {
	if (typeof component === "string") return [...stack, component].join("/");
	let id = functionCacheIds.get(component);
	if (!id) {
		id = `fn${nextFunctionCacheId++}`;
		functionCacheIds.set(component, id);
	}
	return [...stack, id].join("/");
}

function isPromiseLike(value: unknown): value is Promise<string | undefined> {
	return Boolean(value && typeof (value as Promise<unknown>).then === "function");
}

function formatComponentValue(value: string | undefined, options: BarComponentOptions, context: BarRenderContext) {
	let text = value ?? "";
	if (options.fmt) text = options.fmt(text, context);
	text = sanitize(text);
	if (!text && !options.drawEmpty) return undefined;
	if (options.icon) text = sanitize(`${options.icon} ${text}`);
	const pad = padding(options);
	return `${" ".repeat(pad.left)}${text}${" ".repeat(pad.right)}`;
}

function renderComponent(spec: BarComponentSpec, context: BarRenderContext, stack: string[] = []) {
	const { component, options } = normalizeSpec(spec);
	try {
		if (options.minWidth && context.width < options.minWidth) return undefined;
		if (options.cond && !options.cond(context)) return undefined;

		let value: string | undefined | Promise<string | undefined>;
		const key = cacheKey(component, stack);
		const cached = asyncCache.get(key);
		const now = Date.now();
		const interval = options.refreshInterval ?? 0;
		const mayUseCache = cached && (cached.pending || (interval > 0 && now - cached.updatedAt < interval));
		if (mayUseCache) return formatComponentValue(cached.value, options, context);

		if (typeof component === "function") value = component(context);
		else {
			if (stack.includes(component))
				throw new Error(`recursive component reference: ${[...stack, component].join(" -> ")}`);
			const registered = getBarComponent(component);
			if (typeof registered === "function") value = registered(context);
			else if (registered) value = renderComponent(registered, context, [...stack, component]);
			else value = renderBuiltin(component, context);
		}

		if (isPromiseLike(value)) {
			const current = cached ?? { updatedAt: 0 };
			if (!current.pending) {
				current.pending = value
					.then((resolved) => {
						current.value = resolved;
						current.updatedAt = Date.now();
					})
					.catch((error) => reportComponentError(component, context, error))
					.finally(() => {
						current.pending = undefined;
						context.requestRender();
					});
				asyncCache.set(key, current);
			}
			return formatComponentValue(current.value, options, context);
		}

		if (interval > 0) asyncCache.set(key, { value, updatedAt: now });
		return formatComponentValue(value, options, context);
	} catch (error) {
		reportComponentError(component, context, error);
		return undefined;
	}
}

export function renderBarSection(section: BarSectionName, baseContext: BarBaseRenderContext) {
	const specs = getBarConfig().sections?.[section] ?? [];
	let parts = specs
		.map((spec) => {
			const options = normalizeSpec(spec).options;
			const context = { ...baseContext, section };
			const value = renderComponent(spec, context);
			return value
				? { value, sep: componentSeparator(options, section), priority: options.priority ?? 50 }
				: undefined;
		})
		.filter((part): part is { value: string; sep: string; priority: number } => Boolean(part));

	let text = parts.map((part, index) => (index === 0 ? part.value : `${part.sep}${part.value}`)).join("");
	while (visibleWidth(text) > baseContext.width && parts.length > 1) {
		const lowestPriority = Math.min(...parts.map((part) => part.priority));
		const removeAt = parts.findIndex((part) => part.priority === lowestPriority);
		parts = parts.filter((_, index) => index !== removeAt);
		text = parts.map((part, index) => (index === 0 ? part.value : `${part.sep}${part.value}`)).join("");
	}

	const style = getBarConfig().options.sectionStyles?.[section];
	return applySectionStyle(text, style, { ...baseContext, section });
}

function applySectionStyle(text: string, style: BarSectionStyle | undefined, context: BarRenderContext) {
	if (!text || !style) return text;
	if (typeof style === "function") return style(text, context);
	return context.theme.fg(style as never, text);
}

function sectionSeparator(side: "left" | "right") {
	const separator = getBarConfig().options.sectionSeparators;
	return typeof separator === "string" ? separator : (separator[side] ?? "  ");
}

export function joinBarLine(left: string, right: string, width: number) {
	if (width <= 0) return "";
	const config = getBarConfig().options;
	if (!right) return truncateToWidth(left, width, "...");

	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, "...");

	const gapWidth = config.alwaysDivideMiddle || left ? Math.max(1, width - visibleWidth(left) - rightWidth) : 0;
	if (gapWidth > 1) return `${left}${" ".repeat(gapWidth)}${right}`;

	const gap = gapWidth === 1 ? " " : "";
	const leftWidth = Math.max(0, width - rightWidth - gap.length);
	return `${truncateToWidth(left, leftWidth, "...")}${gap}${right}`;
}

export function renderBarLine(baseContext: BarBaseRenderContext) {
	const left = LEFT_SECTIONS.map((section) => renderBarSection(section, baseContext))
		.filter(Boolean)
		.join(sectionSeparator("left"));
	const right = RIGHT_SECTIONS.map((section) => renderBarSection(section, baseContext))
		.filter(Boolean)
		.join(sectionSeparator("right"));
	return joinBarLine(left, right, baseContext.width);
}
