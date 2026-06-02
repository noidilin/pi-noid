// @ts-nocheck
import assert from "node:assert/strict";
import { test } from "vitest";
import { registerBarComponent, registerBarModule, setupBar } from "./api.ts";
import barExtension from "./index.ts";
import {
	markBarSessionStarted,
	renderBarLine,
	renderBarSection,
	resetBarRenderPipelineForTests,
} from "./render-pipeline.ts";

function expectValue(actual: unknown, expected: unknown) {
	if (expected instanceof RegExp) assert.match(String(actual), expected);
	else assert.deepEqual(actual, expected);
}

const allSections = (sections = {}) => ({
	bar_a: [],
	bar_b: [],
	bar_c: [],
	bar_x: [],
	bar_y: [],
	bar_z: [],
	...sections,
});
const baseOptions = (options = {}) => ({
	sectionSeparators: "  ",
	componentSeparators: " ",
	alwaysDivideMiddle: true,
	sectionStyles: {},
	...options,
});

function theme() {
	return { fg: (color, text) => `<${color}>${text}</${color}>`, bold: (text) => `*${text}*` };
}

function context(overrides = {}) {
	const entries = overrides.entries ?? [];
	const notifications = [];
	let renderRequests = 0;
	const ctx = {
		hasUI: true,
		model: overrides.model ?? { provider: "openai", id: "gpt-test", contextWindow: 200000 },
		modelRegistry: { isUsingOAuth: () => Boolean(overrides.oauth) },
		sessionManager: {
			getEntries: () => entries,
			getCwd: () => overrides.cwd ?? "/tmp/project",
			getSessionName: () => overrides.sessionName ?? "session-a",
		},
		getContextUsage: () => overrides.contextUsage,
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setFooter: (footer) => {
				ctx.footer = footer;
			},
		},
		reload: async () => {
			ctx.reloaded = true;
		},
	};
	const footerData = {
		getGitBranch: () => overrides.branch,
		getExtensionStatuses: () => overrides.statuses ?? new Map(),
		getAvailableProviderCount: () => overrides.providerCount ?? 1,
		onBranchChange: () => () => {},
	};
	return {
		ctx,
		theme: theme(),
		footerData,
		width: overrides.width ?? 80,
		requestRender: () => {
			renderRequests += 1;
		},
		notifications,
		get renderRequests() {
			return renderRequests;
		},
	};
}

function configure(sections, options = {}) {
	resetBarRenderPipelineForTests();
	setupBar({ options: baseOptions(options), sections: allSections(sections) });
}

test("render pipeline formats synchronous components behind one seam", () => {
	const first = () => "hello\n\t world";
	const second = () => "name";
	configure({
		bar_a: [
			{ component: first, icon: "●", padding: { left: 1, right: 1 }, fmt: (text) => text.toUpperCase() },
			[second, { separator: " | " }],
			() => "",
			{ component: () => "", drawEmpty: true, icon: "∅" },
		],
		bar_z: [() => "model"],
	});
	const rendered = renderBarLine(context({ width: 40 }));
	expectValue(rendered, " ● HELLO WORLD  | name ∅           model");
});

test("section rendering preserves separators, styles, min width, and priority dropping", () => {
	configure(
		{
			bar_a: [
				{ component: () => "keep", priority: 100 },
				{ component: () => "drop", priority: 1 },
				{ component: () => "wide", minWidth: 20 },
			],
			bar_x: [() => "rx", () => "ry"],
		},
		{
			componentSeparators: { left: " < ", right: " > " },
			sectionStyles: { bar_a: "accent" },
		},
	);
	const base = context({ width: 10 });
	expectValue(renderBarSection("bar_a", base), "<accent>keep</accent>");
	expectValue(renderBarSection("bar_x", base), "rx > ry");
});

test("full-line joining preserves right side when the terminal is cramped", () => {
	configure({ bar_a: [() => "left-content"], bar_z: [() => "right"] });
	expectValue(renderBarLine(context({ width: 12 })), "lef... right");
	expectValue(renderBarLine(context({ width: 4 })), "r...");
});

test("full-line joining accounts for terminal-wide glyphs in narrow bars", () => {
	configure({ bar_a: [() => "🧠"], bar_z: [() => "R"] });
	expectValue(renderBarLine(context({ width: 4 })), "🧠 R");
});

test("full-line joining truncates styled left content without losing right alignment", () => {
	configure(
		{ bar_a: [() => "left-content"], bar_z: [() => "right"] },
		{ sectionStyles: { bar_a: (text) => `\x1b[31m${text}\x1b[0m` } },
	);
	expectValue(renderBarLine(context({ width: 12 })), "\x1b[31mlef\x1b[0m... right");
});

test("built-ins render through the pipeline", () => {
	const undoLegacy = registerBarModule({ key: "legacy-a", priority: 1, render: () => "modern" });
	configure({
		bar_a: ["pwd", "branch", "session", "tokens", "context"],
		bar_z: ["model"],
		bar_x: ["legacy.statuses"],
	});
	const entries = [
		{
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 1200, output: 2000, cacheRead: 300, cacheWrite: 400, cost: { total: 0.0123 } },
			},
		},
	];
	const rendered = renderBarLine(
		context({
			width: 200,
			cwd: `${process.env.HOME}/repo`,
			branch: "main",
			sessionName: "work",
			entries,
			contextUsage: { percent: 75, contextWindow: 200000 },
			providerCount: 2,
			statuses: new Map([["z", "legacy"]]),
		}),
	);
	expectValue(rendered, /~\/repo \(main\) work ↑1\.2k ↓2\.0k R300 W400 \$0\.012 <warning>75\.0%\/200k<\/warning>/);
	expectValue(rendered, /modern legacy/);
	expectValue(rendered, /\(openai\) gpt-test$/);
	undoLegacy();
});

test("session timers and last response timers render through built-ins", () => {
	configure({ bar_a: ["session.time", "last_response.time"] });
	const base = context({
		entries: [{ type: "message", message: { role: "assistant", timestamp: Date.now() - 65000 } }],
	});
	markBarSessionStarted(base.ctx, Date.now() - 125000);
	expectValue(renderBarLine(base), /^2m\d\ds 1m\d\ds/);
});

test("async components cache values, request renders, and report failures once", async () => {
	let resolveValue: (value: string) => void = () => {};
	let calls = 0;
	const asyncName = `async.${Date.now()}`;
	const failName = `fail.${Date.now()}`;
	const undoAsync = registerBarComponent(asyncName, () => {
		calls += 1;
		return new Promise((resolve) => {
			resolveValue = resolve;
		});
	});
	const undoFail = registerBarComponent(failName, () => Promise.reject(new Error("boom")));
	configure({ bar_a: [{ component: asyncName, refreshInterval: 1000 }, failName] });
	const base = context();
	expectValue(renderBarLine(base), "");
	resolveValue("ready");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expectValue(base.renderRequests, 2);
	expectValue(renderBarLine(base), "ready");
	expectValue(renderBarLine(base), "ready");
	expectValue(calls, 1);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expectValue(base.notifications.filter((n) => n.message.includes(failName)).length, 1);
	expectValue(renderBarLine(base), "ready");
	expectValue(base.notifications.filter((n) => n.message.includes(failName)).length, 1);
	undoAsync();
	undoFail();
});

test("recursive component references fail safely", () => {
	const a = `a.${Date.now()}`;
	const b = `b.${Date.now()}`;
	const undoA = registerBarComponent(a, { component: b });
	const undoB = registerBarComponent(b, { component: a });
	configure({ bar_a: [a] });
	const base = context();
	expectValue(renderBarLine(base), "");
	expectValue(base.notifications.length, 1);
	expectValue(base.notifications[0].message, /recursive component reference/);
	undoA();
	undoB();
});

test("bar commands and preset installation continue to use the render pipeline", async () => {
	let command: { handler: (args: string, ctx: unknown) => Promise<void> } = { handler: async () => {} };
	let sessionStart: (event: unknown, ctx: unknown) => Promise<void> = async () => {};
	const pi = {
		registerCommand: (name, def) => {
			if (name === "bar") command = def;
		},
		on: (name, handler) => {
			if (name === "session_start") sessionStart = handler;
		},
	};
	barExtension(pi);
	const base = context();
	await command.handler("status", base.ctx);
	expectValue(base.notifications.at(-1).message, /Bar enabled/);
	await command.handler("off", base.ctx);
	expectValue(base.ctx.footer, undefined);
	await command.handler("on", base.ctx);
	expectValue(typeof base.ctx.footer, "function");
	const footer = base.ctx.footer({ requestRender() {} }, base.theme, base.footerData);
	expectValue(Array.isArray(footer.render(80)), true);
	footer.dispose();
	await command.handler("minimal", base.ctx);
	expectValue(base.notifications.at(-1).message, /Bar preset: minimal/);
	await command.handler("preset nope", base.ctx);
	expectValue(base.notifications.at(-1).message, /Usage: \/bar preset/);
	await command.handler("reload", base.ctx);
	expectValue(base.ctx.reloaded, true);
	base.ctx.footer = undefined;
	await sessionStart({}, base.ctx);
	expectValue(typeof base.ctx.footer, "function");
});
