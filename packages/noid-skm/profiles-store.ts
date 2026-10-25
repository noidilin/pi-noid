import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { PROFILES_PATH } from "./paths";
import { FALLBACK, type ProfileConfig, type ProfileDefinition, sortedNames, upgradeProfiles } from "./profile-policy";
import type { SkillItem } from "./types";

export interface ProfileSnapshot {
	config: ProfileConfig;
	diagnostics: string[];
	readOnly: boolean;
	created: boolean;
	upgraded: boolean;
}

function errorCode(error: unknown): unknown {
	return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

async function writeTemporary(path: string, value: unknown): Promise<string> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	const file = await open(tmp, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await file.sync();
	} finally {
		await file.close();
	}
	return tmp;
}

async function atomicWrite(path: string, value: unknown) {
	const tmp = await writeTemporary(path, value);
	try {
		await rename(tmp, path);
	} finally {
		await unlink(tmp).catch(() => undefined);
	}
}

export function initialProfiles(installed: readonly SkillItem[]): ProfileConfig {
	return {
		schemaVersion: 3,
		defaultProfile: "global",
		coreSkills: [],
		profiles: {
			global: {
				groups: [],
				skills: sortedNames(
					installed
						.filter((skill) => skill.scope === "user" || skill.scope === "temporary")
						.map((skill) => skill.name),
				),
			},
		},
	};
}

export class ProfilesStore {
	private snapshotValue: ProfileSnapshot | undefined;
	constructor(private readonly path = PROFILES_PATH) {}

	async load(installed: readonly SkillItem[]): Promise<ProfileSnapshot> {
		if (this.snapshotValue) return this.snapshotValue;
		try {
			return await this.loadExisting();
		} catch (error) {
			if (errorCode(error) !== "ENOENT") return this.failure(error);
		}
		// Commands can run before skill discovery. Do not persist an accidentally
		// empty inventory; the first run can retry using structured prompt skills.
		if (!installed.length)
			return {
				config: FALLBACK,
				diagnostics: ["No discovered skills yet; retry after resource discovery"],
				readOnly: true,
				created: false,
				upgraded: false,
			};
		const config = initialProfiles(installed);
		let tmp: string | undefined;
		try {
			tmp = await writeTemporary(this.path, config);
			await link(tmp, this.path); // exclusive: never overwrite another writer
			this.snapshotValue = { config, diagnostics: [], readOnly: false, created: true, upgraded: false };
			return this.snapshotValue;
		} catch (error) {
			if (errorCode(error) === "EEXIST") {
				try {
					return await this.loadExisting();
				} catch (readError) {
					return this.failure(readError);
				}
			}
			return this.failure(error);
		} finally {
			if (tmp) await unlink(tmp).catch(() => undefined);
		}
	}

	private async loadExisting(): Promise<ProfileSnapshot> {
		const parsed = upgradeProfiles(JSON.parse(await readFile(this.path, "utf8")));
		if (parsed.upgraded) await atomicWrite(this.path, parsed.config);
		this.snapshotValue = {
			config: parsed.config,
			diagnostics: [],
			readOnly: false,
			created: false,
			upgraded: parsed.upgraded,
		};
		return this.snapshotValue;
	}

	private failure(error: unknown): ProfileSnapshot {
		this.snapshotValue = {
			config: FALLBACK,
			diagnostics: [`Profiles: ${String(error)}`],
			readOnly: true,
			created: false,
			upgraded: false,
		};
		return this.snapshotValue;
	}

	snapshot(): ProfileSnapshot {
		return (
			this.snapshotValue ?? {
				config: FALLBACK,
				diagnostics: ["Profiles not loaded"],
				readOnly: true,
				created: false,
				upgraded: false,
			}
		);
	}

	async setDefault(name: string): Promise<void> {
		const current = this.snapshot();
		if (current.readOnly) throw new Error("Profiles are read-only; run /skm doctor");
		if (!current.config.profiles[name]) throw new Error(`Unknown profile: ${name}`);
		const config = { ...current.config, defaultProfile: name };
		await atomicWrite(this.path, config);
		this.snapshotValue = { ...current, config, created: false, upgraded: false };
	}

	async create(name: string, definition: ProfileDefinition): Promise<void> {
		const current = this.snapshot();
		if (current.readOnly) throw new Error("Profiles are read-only; run /skm doctor");
		if (!name.trim() || name === "core") throw new Error(`Invalid profile: ${name}`);
		if (current.config.profiles[name]) throw new Error(`Profile already exists: ${name}`);
		const config: ProfileConfig = {
			...current.config,
			profiles: {
				...current.config.profiles,
				[name]: { groups: sortedNames(definition.groups), skills: sortedNames(definition.skills) },
			},
		};
		await atomicWrite(this.path, config);
		this.snapshotValue = { ...current, config, created: false, upgraded: false };
	}
}
