import { describe, expect, it } from "vitest";
import { extractParentFromBody } from "./github";

describe("extractParentFromBody", () => {
	it("parses hash issue refs from only the Parent section", () => {
		expect(extractParentFromBody("## Parent\n\n#42\n\n## Notes\n#33")).toBe(42);
	});

	it("parses GitHub issue URLs from the Parent section", () => {
		expect(
			extractParentFromBody(
				"## Parent\n\nhttps://github.com/noidilin/portfolio-devops/issues/42\n\n## What to build\nmentions #33 later",
			),
		).toBe(42);
	});

	it("does not scan later sections for issue refs", () => {
		expect(
			extractParentFromBody("## Parent\n\nhttps://example.com/not-an-issue\n\n## What to build\nmentions #33 later"),
		).toBeUndefined();
	});
});
