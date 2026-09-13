import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** True when pi-mcp-adapter is loaded in this session (its `mcp` tool/commands are registered). */
export function hasMcpAdapter(pi: ExtensionAPI): boolean {
	try {
		if (pi.getAllTools().some((tool) => tool.name === "mcp")) return true;
		return pi.getCommands().some((command) => command.name === "mcp" || command.name === "mcp-auth");
	} catch {
		return false;
	}
}

/** True when pi-mcp-adapter is installed but not yet loaded (pi needs a restart). */
export function hasMcpAdapterExecutable(): boolean {
	const pathValue = process.env.PATH ?? "";
	const executableNames =
		process.platform === "win32"
			? ["pi-mcp-adapter.cmd", "pi-mcp-adapter.exe", "pi-mcp-adapter"]
			: ["pi-mcp-adapter"];

	for (const dir of pathValue.split(delimiter)) {
		if (!dir) continue;
		for (const name of executableNames) {
			if (existsSync(join(dir, name))) return true;
		}
	}

	return false;
}

export function assertMcpAdapterExists(pi: ExtensionAPI): void {
	if (hasMcpAdapter(pi) || hasMcpAdapterExecutable()) return;
	throw new Error(
		"pi-mcp-adapter not found. Install it first with `pi install npm:pi-mcp-adapter`, restart pi, then retry.",
	);
}
