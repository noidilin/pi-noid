import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import remoteFigmaExtension from "./index";

interface RegisteredCommandStub {
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

/** Registers the extension against a stub ExtensionAPI and returns the one command it registers. */
function registerExtension(options: { adapterLoaded?: boolean } = {}): {
	name: string;
	command: RegisteredCommandStub;
} {
	let name = "";
	let command: RegisteredCommandStub | undefined;
	remoteFigmaExtension({
		registerCommand(commandName: string, options: RegisteredCommandStub) {
			name = commandName;
			command = options;
		},
		getAllTools: () => (options.adapterLoaded ? [{ name: "mcp" }] : []),
		getCommands: () => [],
	} as never);
	if (!command) throw new Error("extension registered no command");
	return { name, command };
}

function createContext(cwd: string) {
	const notices: { message: string; type?: string }[] = [];
	const statuses: (string | undefined)[] = [];
	return {
		notices,
		statuses,
		ctx: {
			cwd,
			signal: undefined,
			ui: {
				notify: (message: string, type?: string) => notices.push({ message, type }),
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
				confirm: async () => false,
			},
		},
	};
}

describe("remote-figma extension", () => {
	it("registers a single /figma command with argument completions", () => {
		const { name, command } = registerExtension();
		expect(name).toBe("figma");
		expect(command.description).toMatch(/Figma Remote MCP/);
		expect(command.getArgumentCompletions?.("log")).toMatchObject([{ value: "login" }, { value: "logout" }]);
	});

	it("reports help, including the default endpoint", async () => {
		const { command } = registerExtension();
		const { notices, ctx } = createContext(process.cwd());

		await command.handler("help", ctx);

		expect(notices).toHaveLength(1);
		expect(notices[0].type).toBe("info");
		expect(notices[0].message).toContain("https://mcp.figma.com/mcp");
	});

	it("surfaces parse errors as notifications instead of throwing", async () => {
		const { command } = registerExtension();
		const { notices, ctx } = createContext(process.cwd());

		await command.handler("bogus", ctx);

		expect(notices).toMatchObject([{ type: "error", message: expect.stringContaining("Unknown subcommand") }]);
	});

	it("reports status for a clean directory without touching the network", async () => {
		const { command } = registerExtension({ adapterLoaded: true });
		const cwd = await mkdtemp(path.join(os.tmpdir(), "remote-figma-status-"));
		const { notices, ctx } = createContext(cwd);

		await command.handler("status", ctx);

		expect(notices[0].message).toContain('server: "figma"');
		expect(notices[0].message).toContain("pi-mcp-adapter loaded now:   yes");
	});

	it("writes the mcpServers entry for a project-scoped setup", async () => {
		const { command } = registerExtension({ adapterLoaded: true });
		const cwd = await mkdtemp(path.join(os.tmpdir(), "remote-figma-setup-"));
		const { notices, ctx } = createContext(cwd);

		await command.handler("setup --project --keep-alive", ctx);

		const configPath = path.join(cwd, ".pi", "mcp.json");
		expect(notices[0].message).toContain(configPath);
		const { readFileSync } = await import("node:fs");
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			mcpServers: {
				figma: {
					url: "https://mcp.figma.com/mcp",
					auth: "oauth",
					lifecycle: "keep-alive",
					exposeResources: true,
					directTools: false,
				},
			},
		});
	});

	it("refuses setup when pi-mcp-adapter is absent", async () => {
		const { command } = registerExtension({ adapterLoaded: false });
		const cwd = await mkdtemp(path.join(os.tmpdir(), "remote-figma-noadapter-"));
		const { notices, ctx } = createContext(cwd);
		const realPath = process.env.PATH;
		process.env.PATH = cwd;
		try {
			await command.handler("setup --project", ctx);
		} finally {
			process.env.PATH = realPath;
		}

		expect(notices).toMatchObject([{ type: "error", message: expect.stringContaining("pi-mcp-adapter not found") }]);
	});

	it("does not start OAuth when the confirmation is declined", async () => {
		const { command } = registerExtension({ adapterLoaded: true });
		const cwd = await mkdtemp(path.join(os.tmpdir(), "remote-figma-login-"));
		const { notices, statuses, ctx } = createContext(cwd);

		await command.handler("login", ctx);

		expect(notices).toHaveLength(0);
		expect(statuses).toHaveLength(0);
	});
});
