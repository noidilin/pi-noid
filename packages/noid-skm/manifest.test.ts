import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

const root = join(import.meta.dirname, "..", "..");

test("root Pi manifest loads only the retained extensions", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		pi?: { extensions?: string[] };
	};

	assert.deepEqual(manifest.pi?.extensions, ["./packages/noid-skm/index.ts", "./packages/noid-remote-figma/index.ts"]);
});

test("skill manager has no custom status-bar dependency", () => {
	const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};

	assert.equal(manifest.dependencies?.["noid-bar"], undefined);
});
