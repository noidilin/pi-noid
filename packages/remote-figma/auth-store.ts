import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentPath } from "./paths";

export interface RegisteredClient {
	clientId: string;
	clientSecret?: string;
	clientIdIssuedAt?: number;
	clientSecretExpiresAt?: number;
}

export interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
}

export interface AdapterAuthEntry {
	tokens?: {
		accessToken: string;
		refreshToken?: string;
		expiresAt?: number;
		scope?: string;
	};
	clientInfo?: RegisteredClient;
	codeVerifier?: string;
	oauthState?: string;
	serverUrl?: string;
}

/**
 * Token file paths for a server, current layout first.
 *
 * pi-mcp-adapter >= 2.7.0 addresses each server's token file as
 * `<base>/sha256-<sha256(serverName)>/tokens.json`: 2.7.0-2.12.x read it in place as their live store, and
 * >= 2.13.0 imports it into the OS credential store on the next connect and deletes it. Only releases before
 * 2.7.0 used the plain `<base>/<serverName>/tokens.json` directory. Writing only to the plain directory
 * leaves newer adapters unaware of the credentials, so they retry their own dynamic client registration and
 * Figma rejects that with HTTP 403.
 *
 * The base directory must match the adapter's getAuthBaseDir byte-for-byte: the adapter uses the raw
 * MCP_OAUTH_DIR value (no `~` expansion, no resolving), so no expansion may happen here either.
 */
function getAuthFilePathCandidates(serverName: string): [hashed: string, legacy: string] {
	const base = process.env.MCP_OAUTH_DIR?.trim() || getAgentPath("mcp-oauth");
	const account = `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`;
	return [join(base, account, "tokens.json"), join(base, serverName, "tokens.json")];
}

/** Path `login` writes to. */
export function getAuthFilePath(serverName: string): string {
	return getAuthFilePathCandidates(serverName)[0];
}

/** First existing token file across both layouts, if any. */
export function findAuthFilePath(serverName: string): string | undefined {
	return getAuthFilePathCandidates(serverName).find((path) => existsSync(path));
}

export function saveAdapterAuth(
	serverName: string,
	serverUrl: string,
	client: RegisteredClient,
	tokens: TokenResponse,
): string {
	const now = Math.floor(Date.now() / 1000);
	const entry: AdapterAuthEntry = {
		tokens: {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresAt: tokens.expires_in ? now + tokens.expires_in : undefined,
			scope: tokens.scope,
		},
		clientInfo: client,
		serverUrl,
	};

	const authPath = getAuthFilePath(serverName);
	mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
	writeFileSync(authPath, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(authPath, 0o600);
	} catch {
		// Best effort on platforms without POSIX chmod.
	}

	// Remove a token file left in the pre-2.7.0 plain layout (written by earlier versions of this
	// extension). Newer adapters never read or delete it, so it would linger as live plaintext
	// credentials and shadow `status` once the adapter imports and deletes the current file.
	const [, legacyPath] = getAuthFilePathCandidates(serverName);
	try {
		removeTokenFile(legacyPath);
	} catch {
		// Best effort; the fresh credentials were written successfully.
	}
	return authPath;
}

export function readAuthEntry(path: string): AdapterAuthEntry | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as AdapterAuthEntry;
	} catch {
		return undefined;
	}
}

/** Removes one token file, plus its per-server directory when emptied. */
function removeTokenFile(path: string): boolean {
	if (!existsSync(path)) return false;
	rmSync(path, { force: true });
	try {
		rmdirSync(dirname(path));
	} catch {
		// Directory not empty or already gone; the adapter tolerates either.
	}
	return true;
}

/** Removes plaintext token files from every known layout. */
export function removeAuthFile(serverName: string): boolean {
	let removed = false;
	for (const authPath of getAuthFilePathCandidates(serverName)) {
		if (removeTokenFile(authPath)) removed = true;
	}
	return removed;
}
