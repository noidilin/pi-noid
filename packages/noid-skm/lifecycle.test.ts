import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ dir: "" }));
vi.mock("./paths", () => ({
	get PROFILES_PATH() {
		return `${fixture.dir}/profiles.json`;
	},
	get STATE_PATH() {
		return `${fixture.dir}/legacy.json`;
	},
	PROFILE_CUSTOM_TYPE: "skill-manager-profile-state",
}));

import extension from "./index";

const skill = (name: string, scope: "user" | "project") => ({ name, sourceInfo: { scope } }) as Skill;

test("first custom run locks and each run filters only structured skills; branch replacement resets binding", async () => {
	fixture.dir = await mkdtemp(join(tmpdir(), "skm-lifecycle-"));
	try {
		await writeFile(
			join(fixture.dir, "profiles.json"),
			JSON.stringify({
				schemaVersion: 2,
				defaultProfile: "first",
				coreSkills: [],
				profiles: { first: { skills: ["a"] }, second: { skills: ["b"] } },
			}),
		);
		const handlers: Record<string, (event: any, ctx: any) => Promise<void> | void> = {};
		let command: (args: string, ctx: any) => Promise<void> = async () => {};
		let branch: any[] = [];
		const appended: any[] = [];
		const pi = {
			on: (name: string, handler: any) => {
				handlers[name] = handler;
			},
			registerFlag: () => {},
			getFlag: () => undefined,
			registerCommand: (_name: string, options: any) => {
				command = options.handler;
			},
			appendEntry: (_type: string, data: unknown) => {
				appended.push(data);
				branch.push({ type: "custom", customType: "skill-manager-profile-state", data });
			},
			getCommands: () => [],
			sendMessage: () => {},
		} as unknown as ExtensionAPI;
		const ctx = {
			hasUI: false,
			sessionManager: { getBranch: () => branch, getEntries: () => [] },
			model: undefined,
			ui: {},
		} as unknown as ExtensionContext;
		extension(pi);
		await handlers.session_start({}, ctx);
		const a = skill("a", "user"),
			b = skill("b", "user"),
			p = skill("p", "project");
		const run = () => ({
			messageType: "custom",
			systemPromptOptions: { skills: [a, b, p], sections: { unrelated: "intact" }, selectedTools: ["read"] },
		});
		const first = run();
		await handlers.before_agent_start(first, ctx);
		assert.deepEqual(first.systemPromptOptions.skills, [a, p]);
		assert.deepEqual(first.systemPromptOptions.sections, { unrelated: "intact" });
		assert.deepEqual(first.systemPromptOptions.selectedTools, ["read"]);
		assert.equal(appended.length, 1);
		const second = run();
		await handlers.before_agent_start(second, ctx);
		assert.deepEqual(second.systemPromptOptions.skills, [a, p]);
		assert.equal(appended.length, 1);
		await command("profile second", ctx);
		assert.equal(appended.length, 1);
		branch = [];
		await handlers.session_start({}, ctx);
		await command("profile second", ctx);
		assert.equal(appended.length, 2);
		const third = run();
		await handlers.before_agent_start(third, ctx);
		assert.deepEqual(third.systemPromptOptions.skills, [b, p]);
	} finally {
		await rm(fixture.dir, { recursive: true, force: true });
	}
});
