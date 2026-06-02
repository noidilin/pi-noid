import { readFile } from "node:fs/promises";
import { GROUPS_PATH } from "./paths";
import type { SkillCatalogIssue, SkillGroups, StoreLoadSnapshot } from "./types";

export interface SkillGroupsSnapshot {
	groups: SkillGroups;
	load: StoreLoadSnapshot;
	issues: SkillCatalogIssue[];
}

export function normalizeSkillGroupsConfig(raw: unknown): Pick<SkillGroupsSnapshot, "groups" | "issues"> {
	const groups: SkillGroups = {};
	const issues: SkillCatalogIssue[] = [];
	if (raw === undefined || raw === null) return { groups, issues };
	if (!isPlainObject(raw)) {
		issues.push({ kind: "invalid-groups-config", actual: describeValue(raw) });
		return { groups, issues };
	}
	for (const [group, members] of Object.entries(raw).sort(([a], [b]) => a.localeCompare(b))) {
		if (!Array.isArray(members)) {
			issues.push({ kind: "invalid-group-members", group, actual: describeValue(members) });
			continue;
		}
		const stringMembers: string[] = [];
		for (const member of members) {
			if (typeof member === "string") stringMembers.push(member);
			else issues.push({ kind: "invalid-group-member", group, value: member });
		}
		groups[group] = stringMembers;
	}
	return { groups, issues };
}

export class SkillGroupsStore {
	private snapshotValue: SkillGroupsSnapshot = { groups: {}, load: { status: "missing" }, issues: [] };

	async load(): Promise<SkillGroupsSnapshot> {
		try {
			const raw = await readFile(GROUPS_PATH, "utf8");
			const normalized = normalizeSkillGroupsConfig(JSON.parse(raw) as unknown);
			this.snapshotValue = { ...normalized, load: { status: "loaded" } };
		} catch (error) {
			const code = errorCode(error);
			if (code === "ENOENT") this.snapshotValue = { groups: {}, load: { status: "missing" }, issues: [] };
			else {
				const message = error instanceof Error ? error.message : String(error);
				this.snapshotValue = {
					groups: {},
					load: { status: "error", message },
					issues: [{ kind: "groups-load-error", message }],
				};
			}
		}
		return this.snapshot();
	}

	snapshot(): SkillGroupsSnapshot {
		return {
			groups: Object.fromEntries(
				Object.entries(this.snapshotValue.groups).map(([group, members]) => [group, [...members]]),
			),
			load: { ...this.snapshotValue.load },
			issues: [...this.snapshotValue.issues],
		};
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function describeValue(value: unknown) {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value;
}

function errorCode(error: unknown) {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}
