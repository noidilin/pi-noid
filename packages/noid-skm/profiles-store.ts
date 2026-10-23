import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { PROFILES_PATH, STATE_PATH } from "./paths";
import { FALLBACK, type ProfileConfig, parseProfiles, sortedNames } from "./profile-policy";
import type { SkillItem } from "./types";

export interface ProfileSnapshot {
	config: ProfileConfig;
	diagnostics: string[];
	readOnly: boolean;
	migrated: boolean;
}

function errorCode(error: unknown): unknown {
	return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

async function atomicWrite(path: string, value: unknown) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		const file = await open(tmp, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(tmp, path);
	} catch (error) {
		await unlink(tmp).catch(() => undefined);
		throw error;
	}
}

export function migrateLegacy(
	raw: unknown,
	installed: readonly SkillItem[],
): { config: ProfileConfig; diagnostics: string[] } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid legacy configuration");
	const legacy = raw as Record<string, unknown>;
	if (
		legacy.version !== 1 ||
		!Array.isArray(legacy.disabledSkills) ||
		!legacy.disabledSkills.every((x) => typeof x === "string")
	)
		throw new Error("Invalid or unsupported legacy configuration");
	const globals = new Set(installed.filter((skill) => skill.scope !== "project").map((skill) => skill.name));
	const disabled = new Set(legacy.disabledSkills as string[]);
	const stale = sortedNames([...disabled].filter((name) => !globals.has(name)));
	return {
		config: {
			schemaVersion: 2,
			defaultProfile: "legacy-imported",
			coreSkills: [],
			profiles: { "legacy-imported": { skills: sortedNames([...globals].filter((name) => !disabled.has(name))) } },
		},
		diagnostics: stale.map((name) => `Legacy disabled skill not installed: ${name}`),
	};
}

export class ProfilesStore {
	private snapshotValue: ProfileSnapshot | undefined;
	constructor(
		private readonly path = PROFILES_PATH,
		private readonly legacyPath = STATE_PATH,
	) {}

	async load(installed: readonly SkillItem[]): Promise<ProfileSnapshot> {
		if (this.snapshotValue) return this.snapshotValue;
		try {
			const config = parseProfiles(JSON.parse(await readFile(this.path, "utf8")));
			const diagnostics = await this.legacyDiagnostics(installed);
			this.snapshotValue = { config, diagnostics, readOnly: false, migrated: false };
			return this.snapshotValue;
		} catch (error) {
			if (errorCode(error) !== "ENOENT") {
				this.snapshotValue = {
					config: FALLBACK,
					diagnostics: [`Profiles: ${String(error)}`],
					readOnly: true,
					migrated: false,
				};
				return this.snapshotValue;
			}
		}
		try {
			const raw = JSON.parse(await readFile(this.legacyPath, "utf8"));
			const result = migrateLegacy(raw, installed);
			// Link a completed temporary file exclusively: interrupted migrations never
			// leave a partial destination, and another writer cannot be overwritten.
			await mkdir(dirname(this.path), { recursive: true });
			const tmp = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
			try {
				const file = await open(tmp, "wx", 0o600);
				try {
					await file.writeFile(`${JSON.stringify(result.config, null, 2)}\n`);
					await file.sync();
				} finally {
					await file.close();
				}
				await link(tmp, this.path);
			} finally {
				await unlink(tmp).catch(() => undefined);
			}
			this.snapshotValue = { ...result, readOnly: false, migrated: true };
			return this.snapshotValue;
		} catch (error) {
			if (errorCode(error) === "EEXIST") return this.loadExisting(installed);
			this.snapshotValue = {
				config: FALLBACK,
				diagnostics: [`Migration: ${String(error)}`],
				readOnly: true,
				migrated: false,
			};
			return this.snapshotValue;
		}
	}

	private async legacyDiagnostics(installed: readonly SkillItem[]): Promise<string[]> {
		try {
			return migrateLegacy(JSON.parse(await readFile(this.legacyPath, "utf8")), installed).diagnostics;
		} catch (error) {
			if (errorCode(error) === "ENOENT") return [];
			throw new Error(`Legacy configuration: ${String(error)}`);
		}
	}

	private async loadExisting(installed: readonly SkillItem[]): Promise<ProfileSnapshot> {
		try {
			const config = parseProfiles(JSON.parse(await readFile(this.path, "utf8")));
			const diagnostics = await this.legacyDiagnostics(installed);
			this.snapshotValue = {
				config,
				diagnostics,
				readOnly: false,
				migrated: false,
			};
			return this.snapshotValue;
		} catch (error) {
			this.snapshotValue = {
				config: FALLBACK,
				diagnostics: [`Profiles: ${String(error)}`],
				readOnly: true,
				migrated: false,
			};
			return this.snapshotValue;
		}
	}

	snapshot(): ProfileSnapshot {
		return (
			this.snapshotValue ?? {
				config: FALLBACK,
				diagnostics: ["Profiles not loaded"],
				readOnly: true,
				migrated: false,
			}
		);
	}

	async setDefault(name: string): Promise<void> {
		const current = this.snapshot();
		if (current.readOnly) throw new Error("Profiles are read-only; run /skm doctor");
		if (!current.config.profiles[name]) throw new Error(`Unknown profile: ${name}`);
		const config = { ...current.config, defaultProfile: name };
		await atomicWrite(this.path, config);
		this.snapshotValue = { ...current, config };
	}
}
