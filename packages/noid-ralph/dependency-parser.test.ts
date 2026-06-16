import { describe, expect, it } from "vitest";
import { extractBlockedBySection, parseBlockedByDependencies } from "./dependency-parser";

describe("dependency parser", () => {
	it("returns no dependencies for missing section", () => {
		expect(parseBlockedByDependencies("# Title\nbody")).toEqual([]);
	});

	it("treats None lines as no dependency", () => {
		expect(parseBlockedByDependencies("## Blocked by\nNone - can start immediately")).toEqual([]);
	});

	it("parses multiple issue refs", () => {
		expect(parseBlockedByDependencies("## Blocked by\n- #123\n- #124")).toMatchObject([
			{ kind: "issue", issue: 123 },
			{ kind: "issue", issue: 124 },
		]);
	});

	it("parses GitHub URLs", () => {
		expect(parseBlockedByDependencies("## Blocked by\nhttps://github.com/o/r/issues/55")).toMatchObject([
			{ kind: "issue", issue: 55 },
		]);
	});

	it("parses backticked local paths", () => {
		expect(parseBlockedByDependencies("## Blocked by\n`docs/issues/001-example.md`")).toMatchObject([
			{ kind: "path", path: "docs/issues/001-example.md" },
		]);
	});

	it("parses markdown links to local paths", () => {
		expect(parseBlockedByDependencies("## Blocked by\n- [Example](docs/issues/001-example.md)")).toMatchObject([
			{ kind: "path", path: "docs/issues/001-example.md" },
		]);
	});

	it("returns unresolved text", () => {
		expect(parseBlockedByDependencies("## Blocked by\nsomething vague")).toMatchObject([
			{ kind: "unresolved", raw: "something vague" },
		]);
	});

	it("stops at next h2 heading", () => {
		expect(extractBlockedBySection("## Blocked by\n#1\n## Notes\n#2")).toBe("#1");
	});
});
