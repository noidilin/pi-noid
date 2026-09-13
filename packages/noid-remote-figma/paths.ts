import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(homedir(), ".pi", "agent");
	return expandHome(configured);
}

export function getAgentPath(...segments: string[]): string {
	return join(getAgentDir(), ...segments);
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return resolve(path);
}
