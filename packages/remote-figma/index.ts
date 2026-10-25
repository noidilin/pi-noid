import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { assertMcpAdapterExists, hasMcpAdapter, hasMcpAdapterExecutable } from "./adapter";
import { type Command, completionsFor, DEFAULT_FIGMA_MCP_URL, parseArgs } from "./args";
import { findAuthFilePath, getAuthFilePath, readAuthEntry, removeAuthFile } from "./auth-store";
import { configContainsServer, getKnownConfigPaths, writeMcpConfig } from "./config";
import { runOAuthFlow } from "./oauth";
import { formatUserError } from "./util";

const COMMAND_NAME = "figma";

export default function remoteFigmaExtension(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description: "Setup/auth Figma Remote MCP for pi-mcp-adapter",
		argumentHint: "status|setup|login|logout [--server name] [--url url] [--port n]",
		getArgumentCompletions: (argumentPrefix: string) => completionsFor(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			let command: Command;
			try {
				command = parseArgs(args);
			} catch (error) {
				ctx.ui.notify(formatUserError(error), "error");
				return;
			}

			try {
				await dispatch(pi, ctx, command);
			} catch (error) {
				ctx.ui.notify(formatUserError(error), "error");
			}
		},
	} as any);
}

async function dispatch(pi: ExtensionAPI, ctx: ExtensionCommandContext, command: Command): Promise<void> {
	switch (command.kind) {
		case "help":
			ctx.ui.notify(helpText(), "info");
			return;

		case "status":
			ctx.ui.notify(buildStatus(pi, command.serverName, ctx.cwd), "info");
			return;

		case "setup": {
			assertMcpAdapterExists(pi);
			const path = writeMcpConfig(command, ctx.cwd);
			ctx.ui.notify(
				[
					`Figma Remote MCP config written: ${path}`,
					`Restart pi, then use: mcp({ connect: "${command.serverName}" })`,
				].join("\n"),
				"info",
			);
			return;
		}

		case "login": {
			assertMcpAdapterExists(pi);
			const confirmed = await ctx.ui.confirm(
				"Figma Remote MCP OAuth",
				[
					`Start OAuth for "${command.serverName}" at ${command.url}?`,
					"",
					"pi will show a copyable/clickable authorization URL.",
					"Browser will not auto-open.",
					"",
					`Client name:  ${command.clientName}`,
					`Token store:  ${getAuthFilePath(command.serverName)}`,
				].join("\n"),
			);
			if (!confirmed) return;

			ctx.ui.notify("Starting Figma OAuth flow…", "info");
			ctx.ui.setStatus(COMMAND_NAME, "Waiting for Figma OAuth callback…");
			try {
				const authPath = await runOAuthFlow({
					serverName: command.serverName,
					url: command.url,
					clientName: command.clientName,
					callbackPort: command.callbackPort,
					signal: ctx.signal,
					onAuthorizationUrl: (authorizationUrl, callbackUrl) => {
						ctx.ui.notify(
							[
								"Open this URL in your browser to authorize Figma:",
								authorizationUrl,
								"",
								`Waiting for callback on ${callbackUrl}`,
							].join("\n"),
							"info",
						);
						console.log(`\nFigma MCP authorization URL:\n${authorizationUrl}\n\nCallback URL: ${callbackUrl}\n`);
					},
				});
				ctx.ui.notify(
					[
						`Figma OAuth credentials saved: ${authPath}`,
						`Restart pi or run /mcp reconnect ${command.serverName}.`,
						"pi-mcp-adapter >= 2.13.0 imports the file into the OS credential store on connect and deletes it.",
					].join("\n"),
					"info",
				);
			} finally {
				ctx.ui.setStatus(COMMAND_NAME, undefined);
			}
			return;
		}

		case "logout": {
			const removed = removeAuthFile(command.serverName);
			ctx.ui.notify(
				removed
					? [
							`Removed plaintext Figma OAuth token file(s) for "${command.serverName}".`,
							`Credentials already imported into the OS credential store are not affected — run /mcp logout ${command.serverName} to clear those.`,
						].join("\n")
					: [
							`No plaintext Figma OAuth token files found for "${command.serverName}".`,
							`If you logged in and connected, pi-mcp-adapter imported them into the OS credential store — run /mcp logout ${command.serverName} to clear those.`,
						].join("\n"),
				"info",
			);
			return;
		}
	}
}

function helpText(): string {
	return [
		"Figma Remote MCP for pi-mcp-adapter",
		"",
		`/${COMMAND_NAME} status [--server <name>]`,
		`/${COMMAND_NAME} setup  [--global|--project|--shared] [--direct-tools] [--keep-alive]`,
		`/${COMMAND_NAME} login  [--client-name Codex] [--port <port>]`,
		`/${COMMAND_NAME} logout [--server <name>]`,
		"",
		`Default endpoint:      ${DEFAULT_FIGMA_MCP_URL}`,
		"Default config target: --global (<pi agent dir>/mcp.json)",
	].join("\n");
}

function buildStatus(pi: ExtensionAPI, serverName: string, cwd: string): string {
	const configHits = getKnownConfigPaths(cwd).filter((path) => configContainsServer(path, serverName));
	const authPath = findAuthFilePath(serverName);
	const auth = authPath ? readAuthEntry(authPath) : undefined;
	const adapterPresent = hasMcpAdapter(pi);
	const adapterInstalled = adapterPresent || hasMcpAdapterExecutable();

	const lines = [
		`Figma Remote MCP status (server: "${serverName}")`,
		`pi-mcp-adapter installed:    ${adapterInstalled ? "yes" : "no"}`,
		`pi-mcp-adapter loaded now:   ${adapterPresent ? "yes" : "no"}`,
		`config entries:              ${configHits.length ? configHits.join(", ") : "none"}`,
		`auth file:                   ${authPath ?? "missing (not logged in, or already imported into the OS credential store)"}`,
	];

	if (auth?.tokens?.expiresAt) {
		const expires = new Date(auth.tokens.expiresAt * 1000).toISOString();
		const valid = auth.tokens.expiresAt > Math.floor(Date.now() / 1000) + 60;
		lines.push(`token expires:               ${expires} (${valid ? "valid" : "expired/near expiry"})`);
	} else if (auth?.tokens?.accessToken) {
		lines.push("token expires:               unknown (no expires_in)");
	}
	if (auth?.serverUrl) {
		lines.push(`auth server URL:             ${auth.serverUrl}`);
	}

	return lines.join("\n");
}
