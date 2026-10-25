import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type ConfigTarget = "global" | "project" | "shared";

export type Command =
	| { kind: "help" }
	| { kind: "status"; serverName: string }
	| {
			kind: "setup";
			serverName: string;
			url: string;
			target: ConfigTarget;
			directTools: boolean;
			keepAlive: boolean;
	  }
	| { kind: "login"; serverName: string; url: string; clientName: string; callbackPort: number }
	| { kind: "logout"; serverName: string };

export type CommandKind = Command["kind"];

const SUBCOMMANDS = ["help", "status", "setup", "login", "logout"] as const;
type SubcommandLiteral = (typeof SUBCOMMANDS)[number];

export const DEFAULT_SERVER_NAME = "figma";
export const DEFAULT_FIGMA_MCP_URL = "https://mcp.figma.com/mcp";
export const DEFAULT_CLIENT_NAME = "Codex";
export const DEFAULT_CALLBACK_PORT = 0;

const FLAG_DESCRIPTIONS: Record<string, string> = {
	"--global": "Write config to <pi agent dir>/mcp.json (default)",
	"--project": "Write config to .pi/mcp.json (project-local)",
	"--shared": "Write config to .mcp.json (shared/checked-in)",
	"--server": "Server name in mcpServers (default: figma)",
	"--url": "Remote MCP endpoint (default: https://mcp.figma.com/mcp)",
	"--client-name": "OAuth client_name to register (default: Codex)",
	"--port": "Fixed callback port (default: random free)",
	"--direct-tools": "Expose tools directly instead of via the proxy",
	"--keep-alive": "Keep the MCP connection open instead of lazy",
};

const SUBCOMMAND_DESCRIPTIONS: Record<SubcommandLiteral, string> = {
	help: "Show help",
	status: "Show current install/config/auth status",
	setup: "Write the Figma Remote MCP entry into pi's mcp.json",
	login: "Run OAuth and save tokens for pi-mcp-adapter",
	logout: "Remove the saved OAuth tokens",
};

const FLAGS_BY_SUBCOMMAND: Record<SubcommandLiteral, readonly string[]> = {
	help: [],
	status: ["--server"],
	setup: ["--global", "--project", "--shared", "--server", "--url", "--direct-tools", "--keep-alive"],
	login: ["--server", "--url", "--client-name", "--port"],
	logout: ["--server"],
};

export function parseArgs(input: string): Command {
	const tokens = tokenize(input.trim());
	const subcommandToken = (tokens.shift() ?? "help") as string;

	if (!isSubcommand(subcommandToken)) {
		throw new Error(`Unknown subcommand: "${subcommandToken}". Try: ${SUBCOMMANDS.join(", ")}`);
	}

	const flags = collectFlags(tokens, subcommandToken);

	switch (subcommandToken) {
		case "help":
			return { kind: "help" };
		case "status":
			return { kind: "status", serverName: flags.serverName ?? DEFAULT_SERVER_NAME };
		case "setup":
			return {
				kind: "setup",
				serverName: flags.serverName ?? DEFAULT_SERVER_NAME,
				url: validateUrl(flags.url ?? DEFAULT_FIGMA_MCP_URL),
				target: flags.target ?? "global",
				directTools: flags.directTools ?? false,
				keepAlive: flags.keepAlive ?? false,
			};
		case "login":
			return {
				kind: "login",
				serverName: flags.serverName ?? DEFAULT_SERVER_NAME,
				url: validateUrl(flags.url ?? DEFAULT_FIGMA_MCP_URL),
				clientName: flags.clientName ?? DEFAULT_CLIENT_NAME,
				callbackPort: flags.callbackPort ?? DEFAULT_CALLBACK_PORT,
			};
		case "logout":
			return { kind: "logout", serverName: flags.serverName ?? DEFAULT_SERVER_NAME };
	}
}

export function completionsFor(prefix: string): AutocompleteItem[] | null {
	const tokens = tokenize(prefix.replace(/\s+$/, ""));
	const trailingSpace = /\s$/.test(prefix);
	const subcommandToken = tokens[0];
	const subcommand = isSubcommand(subcommandToken) ? subcommandToken : null;
	const last = trailingSpace ? "" : (tokens.at(-1) ?? "");

	const completingSubcommand = tokens.length <= 1 && !trailingSpace;
	const candidates = completingSubcommand ? [...SUBCOMMANDS] : subcommand ? [...FLAGS_BY_SUBCOMMAND[subcommand]] : [];

	const items: AutocompleteItem[] = candidates
		.filter((value) => value.startsWith(last))
		.map((value) => ({
			value,
			label: value,
			description: completingSubcommand
				? SUBCOMMAND_DESCRIPTIONS[value as SubcommandLiteral]
				: FLAG_DESCRIPTIONS[value],
		}));

	return items.length > 0 ? items : null;
}

interface CollectedFlags {
	serverName?: string;
	url?: string;
	clientName?: string;
	callbackPort?: number;
	target?: ConfigTarget;
	directTools?: boolean;
	keepAlive?: boolean;
}

function collectFlags(tokens: string[], subcommand: SubcommandLiteral): CollectedFlags {
	const allowed = new Set(FLAGS_BY_SUBCOMMAND[subcommand]);
	const flags: CollectedFlags = {};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token.startsWith("--")) {
			throw new Error(`Unexpected argument: ${token}`);
		}
		if (!allowed.has(token)) {
			throw new Error(rejectFlagMessage(token, subcommand));
		}

		switch (token) {
			case "--global":
				flags.target = "global";
				break;
			case "--project":
				flags.target = "project";
				break;
			case "--shared":
				flags.target = "shared";
				break;
			case "--direct-tools":
				flags.directTools = true;
				break;
			case "--keep-alive":
				flags.keepAlive = true;
				break;
			case "--server":
				flags.serverName = validateServerName(requireValue(tokens, ++i, token));
				break;
			case "--url":
				flags.url = requireValue(tokens, ++i, token);
				break;
			case "--client-name":
				flags.clientName = requireValue(tokens, ++i, token);
				break;
			case "--port":
				flags.callbackPort = parsePort(requireValue(tokens, ++i, token));
				break;
			default:
				throw new Error(`Unknown option: ${token}`);
		}
	}

	return flags;
}

function rejectFlagMessage(flag: string, subcommand: SubcommandLiteral): string {
	const allowed = FLAGS_BY_SUBCOMMAND[subcommand];
	if (!allowed.length) return `${flag} is not valid for "${subcommand}" (no options accepted)`;
	return `${flag} is not valid for "${subcommand}". Allowed: ${allowed.join(", ")}`;
}

function isSubcommand(value: string | undefined): value is SubcommandLiteral {
	return !!value && (SUBCOMMANDS as readonly string[]).includes(value);
}

function tokenize(input: string): string[] {
	const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
	return [...input.matchAll(pattern)].map((match) => (match[1] ?? match[2] ?? match[3]).replace(/\\(["'\\])/g, "$1"));
}

function requireValue(tokens: string[], index: number, option: string): string {
	const value = tokens[index];
	if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
	return value;
}

function parsePort(value: string): number {
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${value}`);
	return port;
}

function validateServerName(serverName: string): string {
	if (!/^[A-Za-z0-9_.-]+$/.test(serverName) || /^\.+$/.test(serverName)) {
		throw new Error(
			"Server name may contain only letters, numbers, dot, underscore, and dash (and cannot be dots only)",
		);
	}
	return serverName;
}

function validateUrl(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`Invalid --url: ${value}`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(`--url must be http(s): ${value}`);
	}
	return parsed.href;
}
