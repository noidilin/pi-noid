import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

const root = join(import.meta.dirname, "..", "..");

test("root Pi manifest loads each homemade extension once by entrypoint", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		pi?: { extensions?: string[] };
	};

	assert.deepEqual(manifest.pi?.extensions, [
		"./packages/noid-bar/index.ts",
		"./packages/noid-skm/index.ts",
		"./packages/noid-bar-config/index.ts",
		"./packages/noid-ralph/index.ts",
	]);
});
