import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigTarget } from "./args";
import { getAgentPath } from "./paths";
import { asRecord, readJsonObject } from "./util";

export interface WriteMcpConfigOptions {
	serverName: string;
	url: string;
	target: ConfigTarget;
	directTools: boolean;
	keepAlive: boolean;
}

export function writeMcpConfig(options: WriteMcpConfigOptions, cwd: string): string {
	const configPath = getMcpConfigPath(options.target, cwd);
	const config = readJsonObject(configPath);
	const mcpServers = asRecord(config.mcpServers);
	const server = {
		url: options.url,
		auth: "oauth",
		lifecycle: options.keepAlive ? "keep-alive" : "lazy",
		exposeResources: true,
		directTools: options.directTools,
	};

	mcpServers[options.serverName] = server;
	config.mcpServers = mcpServers;

	mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	return configPath;
}

export function getMcpConfigPath(target: ConfigTarget, cwd: string): string {
	switch (target) {
		case "global":
			return getAgentPath("mcp.json");
		case "project":
			return join(cwd, ".pi", "mcp.json");
		case "shared":
			return join(cwd, ".mcp.json");
	}
}

export function getKnownConfigPaths(cwd: string): string[] {
	return [getAgentPath("mcp.json"), join(cwd, ".pi", "mcp.json"), join(cwd, ".mcp.json")];
}

export function configContainsServer(path: string, serverName: string): boolean {
	if (!existsSync(path)) return false;
	try {
		const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return Boolean(asRecord(config.mcpServers)[serverName]);
	} catch {
		return false;
	}
}
