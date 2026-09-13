import { describe, expect, it } from "vitest";
import {
	completionsFor,
	DEFAULT_CALLBACK_PORT,
	DEFAULT_CLIENT_NAME,
	DEFAULT_FIGMA_MCP_URL,
	DEFAULT_SERVER_NAME,
	parseArgs,
} from "./args";

describe("parseArgs", () => {
	it("defaults to help on empty input", () => {
		expect(parseArgs("")).toEqual({ kind: "help" });
	});

	it("applies Figma defaults to setup and login", () => {
		expect(parseArgs("setup")).toEqual({
			kind: "setup",
			serverName: DEFAULT_SERVER_NAME,
			url: DEFAULT_FIGMA_MCP_URL,
			target: "global",
			directTools: false,
			keepAlive: false,
		});
		expect(parseArgs("login")).toEqual({
			kind: "login",
			serverName: DEFAULT_SERVER_NAME,
			url: DEFAULT_FIGMA_MCP_URL,
			clientName: DEFAULT_CLIENT_NAME,
			callbackPort: DEFAULT_CALLBACK_PORT,
		});
	});

	it("reads config target and boolean flags for setup", () => {
		expect(parseArgs("setup --project --direct-tools --keep-alive")).toMatchObject({
			target: "project",
			directTools: true,
			keepAlive: true,
		});
		expect(parseArgs("setup --shared")).toMatchObject({ target: "shared" });
	});

	it("reads valued flags, including quoted values", () => {
		expect(parseArgs('login --client-name "Visual Studio Code" --port 7777')).toMatchObject({
			clientName: "Visual Studio Code",
			callbackPort: 7777,
		});
		expect(parseArgs("status --server figma-dev")).toMatchObject({ serverName: "figma-dev" });
	});

	it("rejects unknown subcommands and stray positional arguments", () => {
		expect(() => parseArgs("bogus")).toThrow(/Unknown subcommand/);
		expect(() => parseArgs("status figma")).toThrow(/Unexpected argument/);
	});

	it("rejects flags that do not belong to the subcommand", () => {
		expect(() => parseArgs("status --port 1234")).toThrow(/not valid for "status"/);
		expect(() => parseArgs("help --server figma")).toThrow(/no options accepted/);
		expect(() => parseArgs("login --direct-tools")).toThrow(/not valid for "login"/);
	});

	it("rejects flags missing a value", () => {
		expect(() => parseArgs("status --server")).toThrow(/--server requires a value/);
		expect(() => parseArgs("login --port --server figma")).toThrow(/--port requires a value/);
	});

	it("validates ports", () => {
		expect(() => parseArgs("login --port 70000")).toThrow(/Invalid port/);
		expect(() => parseArgs("login --port nope")).toThrow(/Invalid port/);
		expect(parseArgs("login --port 0")).toMatchObject({ callbackPort: 0 });
	});

	it("validates server names so they stay safe path segments", () => {
		expect(() => parseArgs("status --server ../escape")).toThrow(/Server name may contain only/);
		expect(() => parseArgs("status --server ..")).toThrow(/Server name may contain only/);
		expect(parseArgs("status --server figma_2.prod")).toMatchObject({ serverName: "figma_2.prod" });
	});

	it("validates the endpoint URL", () => {
		expect(() => parseArgs("setup --url not-a-url")).toThrow(/Invalid --url/);
		expect(() => parseArgs("setup --url file:///etc/passwd")).toThrow(/must be http\(s\)/);
		expect(parseArgs("setup --url https://mcp.figma.com/mcp")).toMatchObject({
			url: "https://mcp.figma.com/mcp",
		});
	});
});

describe("completionsFor", () => {
	it("completes subcommands while the first token is being typed", () => {
		expect(completionsFor("s")?.map((item) => item.value)).toEqual(["status", "setup"]);
		expect(completionsFor("log")?.map((item) => item.value)).toEqual(["login", "logout"]);
	});

	it("completes only the flags allowed for the subcommand", () => {
		expect(completionsFor("login ")?.map((item) => item.value)).toEqual([
			"--server",
			"--url",
			"--client-name",
			"--port",
		]);
		expect(completionsFor("status ")?.map((item) => item.value)).toEqual(["--server"]);
		expect(completionsFor("setup --k")?.map((item) => item.value)).toEqual(["--keep-alive"]);
	});

	it("returns null when nothing matches", () => {
		expect(completionsFor("zzz")).toBeNull();
		expect(completionsFor("help ")).toBeNull();
		expect(completionsFor("login --nope")).toBeNull();
	});
});
