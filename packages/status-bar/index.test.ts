import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { layoutStatusBar } from "./index.ts";

describe("status bar layout", () => {
	it("centers usage and aligns the outer sections", () => {
		const line = layoutStatusBar(80, "~/work $0.012 (1k tokens)", "codex 89%", "gpt · medium");
		expect(line.startsWith("~/work")).toBe(true);
		expect(line.indexOf("codex 89%")).toBe(35);
		expect(line.endsWith("gpt · medium")).toBe(true);
		expect(visibleWidth(line)).toBe(80);
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
