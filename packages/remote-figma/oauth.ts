import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { type RegisteredClient, saveAdapterAuth, type TokenResponse } from "./auth-store";
import { base64Url, fetchJson, optionalNumberField, optionalStringField, stringField } from "./util";

const CALLBACK_PATH = "/callback";
// Bind loopback only so the callback is never reachable from the LAN, but advertise "localhost" in the
// redirect_uri. The two must stay split: Figma accepts a literal 127.0.0.1 at registration and at authorize,
// then rejects the token exchange with invalid_grant, so the advertised host has to be "localhost". This is
// the same combination mcp-auth-helper uses against Figma. Browsers reach a 127.0.0.1 listener via
// "localhost" even on dual-stack hosts, so the split costs nothing.
const CALLBACK_BIND_HOST = "127.0.0.1";
const CALLBACK_ADVERTISED_HOST = "localhost";

/** Redirect URI handed to Figma and sent back verbatim at token exchange. */
export function buildCallbackUrl(port: number): string {
	return `http://${CALLBACK_ADVERTISED_HOST}:${port}${CALLBACK_PATH}`;
}
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

export interface OAuthFlowOptions {
	serverName: string;
	url: string;
	clientName: string;
	callbackPort: number;
	signal?: AbortSignal;
	onAuthorizationUrl: (authorizationUrl: string, callbackUrl: string) => void;
}

export async function runOAuthFlow(options: OAuthFlowOptions): Promise<string> {
	const { codeVerifier, codeChallenge } = generatePkce();
	const state = base64Url(randomBytes(32));
	const callbackListener = await waitForCallback(options.callbackPort, state, options.signal);
	const redirectUri = callbackListener.callbackUrl;

	try {
		const endpoints = await discoverOAuthEndpoints(options.url, options.signal);
		if (!endpoints.registrationEndpoint) {
			throw new Error("OAuth metadata did not include a registration_endpoint");
		}

		const client = await registerClient(
			endpoints.registrationEndpoint,
			redirectUri,
			options.clientName,
			options.signal,
		);
		const authorizationUrl = buildAuthorizationUrl(
			endpoints.authorizationEndpoint,
			client.clientId,
			redirectUri,
			codeChallenge,
			state,
		);

		options.onAuthorizationUrl(authorizationUrl, redirectUri);

		const callback = await callbackListener.result;
		const tokens = await exchangeCodeForTokens(
			endpoints.tokenEndpoint,
			client,
			redirectUri,
			callback.code,
			codeVerifier,
			options.signal,
		);
		return saveAdapterAuth(options.serverName, options.url, client, tokens);
	} finally {
		callbackListener.close();
	}
}

interface OAuthEndpoints {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint?: string;
}

async function discoverOAuthEndpoints(serverUrl: string, signal?: AbortSignal): Promise<OAuthEndpoints> {
	const base = new URL(serverUrl);
	const wellKnownUrl = new URL("/.well-known/oauth-authorization-server", base.origin).href;
	const metadata = await fetchJson<Record<string, unknown>>(wellKnownUrl, { signal });
	const authorizationEndpoint = stringField(metadata, "authorization_endpoint");
	const tokenEndpoint = stringField(metadata, "token_endpoint");
	const registrationEndpoint = optionalStringField(metadata, "registration_endpoint");

	if (!authorizationEndpoint || !tokenEndpoint) {
		throw new Error(`Invalid OAuth metadata from ${wellKnownUrl}`);
	}

	return { authorizationEndpoint, tokenEndpoint, registrationEndpoint };
}

async function registerClient(
	registrationEndpoint: string,
	redirectUri: string,
	clientName: string,
	signal?: AbortSignal,
): Promise<RegisteredClient> {
	const body = {
		redirect_uris: [redirectUri],
		client_name: clientName,
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};

	const result = await fetchJson<Record<string, unknown>>(registrationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});

	const clientId = stringField(result, "client_id");
	if (!clientId) throw new Error("OAuth registration response missing client_id");

	return {
		clientId,
		clientSecret: optionalStringField(result, "client_secret"),
		clientIdIssuedAt: optionalNumberField(result, "client_id_issued_at"),
		clientSecretExpiresAt: optionalNumberField(result, "client_secret_expires_at"),
	};
}

function generatePkce(): { codeVerifier: string; codeChallenge: string } {
	const codeVerifier = base64Url(randomBytes(32));
	const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
	return { codeVerifier, codeChallenge };
}

function buildAuthorizationUrl(
	authorizationEndpoint: string,
	clientId: string,
	redirectUri: string,
	codeChallenge: string,
	state: string,
): string {
	const url = new URL(authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	return url.href;
}

async function exchangeCodeForTokens(
	tokenEndpoint: string,
	client: RegisteredClient,
	redirectUri: string,
	code: string,
	codeVerifier: string,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	const params = new URLSearchParams();
	params.set("grant_type", "authorization_code");
	params.set("code", code);
	params.set("redirect_uri", redirectUri);
	params.set("client_id", client.clientId);
	params.set("code_verifier", codeVerifier);
	if (client.clientSecret) params.set("client_secret", client.clientSecret);

	const result = await fetchJson<Record<string, unknown>>(tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
		signal,
	});

	const accessToken = stringField(result, "access_token");
	if (!accessToken) throw new Error("Token response missing access_token");

	return {
		access_token: accessToken,
		refresh_token: optionalStringField(result, "refresh_token"),
		expires_in: optionalNumberField(result, "expires_in"),
		scope: optionalStringField(result, "scope"),
		token_type: optionalStringField(result, "token_type") ?? "Bearer",
	};
}

interface CallbackListener {
	callbackUrl: string;
	result: Promise<{ code: string; state: string }>;
	close: () => void;
}

async function waitForCallback(
	port: number,
	expectedState: string,
	signal: AbortSignal | undefined,
): Promise<CallbackListener> {
	let resolveResult!: (result: { code: string; state: string }) => void;
	let rejectResult!: (error: unknown) => void;
	const result = new Promise<{ code: string; state: string }>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});

	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abortHandler: (() => void) | undefined;

	const close = () => {
		if (closed) return;
		closed = true;
		if (timer) clearTimeout(timer);
		if (abortHandler) signal?.removeEventListener("abort", abortHandler);
		try {
			server.close();
		} catch {
			// Server may not be listening yet when a bind error fires.
		}
	};

	const fail = (error: unknown) => {
		rejectResult(error);
		close();
	};

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let url: URL;
		try {
			const host = req.headers.host ?? `${CALLBACK_ADVERTISED_HOST}:${port}`;
			url = new URL(req.url ?? "/", `http://${host}`);
		} catch {
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("Bad request");
			return;
		}

		if (url.pathname !== CALLBACK_PATH) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not found");
			return;
		}

		const oauthError = url.searchParams.get("error");
		if (oauthError) {
			const description = url.searchParams.get("error_description") ?? "OAuth error";
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end(`${oauthError}: ${description}`);
			fail(new Error(`${oauthError}: ${description}`));
			return;
		}

		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (!code || !state) {
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("OAuth callback missing code or state");
			return;
		}

		if (state !== expectedState) {
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("OAuth state mismatch");
			return;
		}

		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(successHtml());
		resolveResult({ code, state });
		close();
	});

	await new Promise<void>((resolve, reject) => {
		const onBindError = (error: unknown) => {
			close();
			reject(error);
		};
		server.once("error", onBindError);
		// Bind loopback only: the callback must never be reachable from the LAN.
		server.listen(port, CALLBACK_BIND_HOST, () => {
			server.off("error", onBindError);
			server.on("error", fail);
			resolve();
		});
	});

	timer = setTimeout(() => {
		fail(new Error("Timed out waiting for OAuth callback"));
	}, AUTH_TIMEOUT_MS);

	if (signal) {
		if (signal.aborted) {
			fail(new Error("Aborted"));
		} else {
			abortHandler = () => fail(new Error("Aborted"));
			signal.addEventListener("abort", abortHandler, { once: true });
		}
	}

	const address = server.address();
	const actualPort = typeof address === "object" && address ? address.port : port;
	return { callbackUrl: buildCallbackUrl(actualPort), result, close };
}

function successHtml(): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>Figma MCP authorized</title>
	</head>
	<body style="font-family:system-ui,sans-serif;margin:3rem;max-width:32rem">
		<h1>Figma MCP authorized</h1>
		<p>You can close this tab and return to pi.</p>
	</body>
</html>
`;
}
