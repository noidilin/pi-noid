import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { EMPTY_GROUPS, type GroupConfig, parseGroups, validDefinitionName } from "./group-policy";
import { GROUPS_PATH } from "./paths";
import { sortedNames } from "./profile-policy";

export interface GroupSnapshot {
	config: GroupConfig;
	diagnostics: string[];
	readOnly: boolean;
	missing: boolean;
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
	} finally {
		await unlink(tmp).catch(() => undefined);
	}
}

export class GroupsStore {
	private snapshotValue: GroupSnapshot | undefined;
	constructor(private readonly path = GROUPS_PATH) {}

	async load(): Promise<GroupSnapshot> {
		if (this.snapshotValue) return this.snapshotValue;
		try {
			this.snapshotValue = {
				config: parseGroups(JSON.parse(await readFile(this.path, "utf8"))),
				diagnostics: [],
				readOnly: false,
				missing: false,
			};
		} catch (error) {
			this.snapshotValue =
				errorCode(error) === "ENOENT"
					? { config: EMPTY_GROUPS, diagnostics: [], readOnly: false, missing: true }
					: {
							config: EMPTY_GROUPS,
							diagnostics: [`Groups: ${String(error)}`],
							readOnly: true,
							missing: false,
						};
		}
		return this.snapshotValue;
	}

	snapshot(): GroupSnapshot {
		return (
			this.snapshotValue ?? {
				config: EMPTY_GROUPS,
				diagnostics: ["Groups not loaded"],
				readOnly: true,
				missing: true,
			}
		);
	}

	async create(name: string, skills: readonly string[]): Promise<void> {
		const current = this.snapshot();
		if (current.readOnly) throw new Error("Groups are read-only; run /skm doctor");
		if (!validDefinitionName(name)) throw new Error(`Invalid group: ${name}`);
		if (current.config.groups[name]) throw new Error(`Group already exists: ${name}`);
		const config: GroupConfig = {
			...current.config,
			groups: { ...current.config.groups, [name]: { skills: sortedNames(skills) } },
		};
		await atomicWrite(this.path, config);
		this.snapshotValue = { config, diagnostics: [], readOnly: false, missing: false };
	}
}
