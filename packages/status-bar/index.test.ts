import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { formatTokens, layoutStatusBar } from "./index.ts";

describe("Pi's original token formatting", () => {
	it("preserves precision, units, and capitalization", () => {
		expect([999, 1500, 12500, 1500000, 12500000].map(formatTokens)).toEqual(["999", "1.5k", "13k", "1.5M", "13M"]);
	});
});

describe("status bar layout", () => {
	it("groups usage with the model on the right", () => {
		const line = layoutStatusBar(80, "~/work $0.012 (1k tokens)", "codex 89%", "gpt · medium");
		expect(line.startsWith("~/work")).toBe(true);
		expect(line.endsWith("codex 89%  gpt · medium")).toBe(true);
		expect(line.endsWith("gpt · medium")).toBe(true);
		expect(visibleWidth(line)).toBe(80);
	});

	it("allows the left section to extend past the midpoint", () => {
		const left = "cwd ↑12k ↓3k R100k CH95% $0.100 (sub) 20%/200k (auto)";
		const line = layoutStatusBar(80, left, "89%", "model");
		expect(line.startsWith(left)).toBe(true);
		expect(line.endsWith("89%  model")).toBe(true);
	});

	it("fits narrow terminals, ANSI colors, and wide characters", () => {
		for (let width = 0; width <= 120; width++) {
			const line = layoutStatusBar(
				width,
				"\x1b[31m~/项目/long-path\x1b[0m",
				"codex 89% ↻ 2h30m · 97%",
				"model · medium",
			);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps the outer sections aligned when usage is unavailable", () => {
		const line = layoutStatusBar(40, "cwd", "", "model · off");
		expect(line.startsWith("cwd")).toBe(true);
		expect(line.endsWith("model · off")).toBe(true);
		expect(visibleWidth(line)).toBe(40);
	});
});
