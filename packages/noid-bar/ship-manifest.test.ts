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
		"./packages/noid-alive/index.ts",
		"./packages/noid-remote-figma/index.ts",
	]);
});

// noid-ralph is parked, not deleted: the source and its tests stay in the workspace so they keep
// typechecking and running, but the entrypoint is off the manifest so pi does not load the extension.
// Re-enable by adding "./packages/noid-ralph/index.ts" back to pi.extensions and to the list above.
test("root Pi manifest leaves the parked noid-ralph extension unloaded", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		pi?: { extensions?: string[] };
	};

	assert.ok(
		!manifest.pi?.extensions?.some((entrypoint) => entrypoint.includes("noid-ralph")),
		"noid-ralph is parked and must not be listed in pi.extensions",
	);
});
