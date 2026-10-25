import { existsSync, readFileSync } from "node:fs";

export function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

export function stringField(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : "";
}

export function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

export function optionalNumberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" ? value : undefined;
}

export function base64Url(buffer: Buffer): string {
	return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function formatUserError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function readJsonObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`Failed to read ${path}: ${formatUserError(error)}`);
	}
	try {
		return asRecord(JSON.parse(raw));
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}: ${formatUserError(error)}`);
	}
}

export async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
	const method = init?.method ?? "GET";
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
	const response = await fetch(url, { ...init, signal });
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`${method} ${url} failed: ${response.status} ${response.statusText}${text ? ` - ${text.slice(0, 500)}` : ""}`,
		);
	}
	try {
		return (await response.json()) as T;
	} catch {
		throw new Error(`${method} ${url} returned non-JSON body`);
	}
}
