// @ts-nocheck
import assert from "node:assert/strict";
import { test } from "vitest";
import {
	installSkillManagerFooter,
	joinFooterSides,
	renderSkillFooterLine,
	setSkillFooterThinkingLevel,
} from "./footer";

function createContext(overrides = {}) {
	const entries = overrides.entries ?? [];
	const ctx = {
		hasUI: overrides.hasUI ?? true,
		model: overrides.model ?? { provider: "openai", id: "gpt-test", contextWindow: 200_000, reasoning: true },
		modelRegistry: { isUsingOAuth: () => Boolean(overrides.oauth) },
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => overrides.sessionName ?? "work",
		},
		getContextUsage: () => overrides.contextUsage ?? { percent: 42, contextWindow: 200_000 },
		ui: {
			setFooter: (factory) => {
				ctx.footerFactory = factory;
			},
		},
	};
	return ctx;
}

const theme = { fg: (_color, text) => text };
const footerData = {
	getExtensionStatuses: () => new Map([["git", "clean"]]),
	getAvailableProviderCount: () => 2,
	onBranchChange: () => () => {},
};

test("renders the former noid-bar layout inside skill manager", () => {
	setSkillFooterThinkingLevel("medium");
	const ctx = createContext({
		entries: [
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 1_200, output: 300, cacheRead: 50, cost: { total: 0.0123 } },
				},
			},
		],
	});

	const line = renderSkillFooterLine({
		ctx,
		theme,
		footerData,
		width: 140,
		skillStatus: "skills: custom (-3)",
	});

	assert.match(line, /^work {2}↑1\.2k ↓300 R50 \$0\.012 {2}42\.0%\/200k/);
	assert.match(line, /clean {2}skills: custom \(-3\) {2}\(openai\) gpt-test {2}medium$/);
});

test("keeps the right side visible in narrow terminals", () => {
	const line = joinFooterSides("long-left-content", "model medium", 20).replace(/\x1b\[[0-9;]*m/g, "");
	assert.equal(line, "long... model medium");
});

test("installs the footer only when UI is available", () => {
	const tuiContext = createContext();
	installSkillManagerFooter(tuiContext, () => "skills: all");
	assert.equal(typeof tuiContext.footerFactory, "function");

	const headlessContext = createContext({ hasUI: false });
	installSkillManagerFooter(headlessContext, () => "skills: all");
	assert.equal(headlessContext.footerFactory, undefined);
});
