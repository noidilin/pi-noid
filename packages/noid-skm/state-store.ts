import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { STATE_CUSTOM_TYPE, STATE_PATH } from "./paths";
import type { SkillManagerSelection, StoredSkillManagerSelection } from "./state-transition";
import type { SelectedSkillSet, SkillCatalogIssue, SkillManagerState, StoreLoadSnapshot } from "./types";

export interface SkillManagerStateSnapshot extends StoredSkillManagerSelection {
	load: StoreLoadSnapshot;
	issues: SkillCatalogIssue[];
}

async function writeJsonAtomic(path: string, content: string) {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, content, "utf8");
	await rename(tempPath, path);
}

function isSelectedSkillSet(value: unknown): value is SelectedSkillSet {
	if (!value || typeof value !== "object" || !("kind" in value)) return false;
	const input = value as { kind?: unknown; groups?: unknown };
	if (input.kind === "all" || input.kind === "none" || input.kind === "custom") return true;
	return (
		input.kind === "groups" && Array.isArray(input.groups) && input.groups.every((group) => typeof group === "string")
	);
}

export function normalizeSkillManagerStateConfig(raw: unknown): StoredSkillManagerSelection {
	const parsed = isPlainObject(raw) ? (raw as Partial<SkillManagerState>) : {};
	return {
		disabledSkills: new Set((parsed.disabledSkills ?? []).filter((name): name is string => typeof name === "string")),
		...(isSelectedSkillSet(parsed.selectedSkillSet) ? { selectedSkillSet: parsed.selectedSkillSet } : {}),
	};
}

export class SkillManagerStateStore {
	private disabledSkills = new Set<string>();
	private selectedSkillSet: SelectedSkillSet | undefined;
	private loadSnapshot: StoreLoadSnapshot = { status: "missing" };
	private issues: SkillCatalogIssue[] = [];
	private loaded = false;
	private saveQueue: Promise<void> = Promise.resolve();
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	async load(): Promise<SkillManagerStateSnapshot> {
		if (this.loaded) return this.snapshot();
		this.loaded = true;
		try {
			const raw = await readFile(STATE_PATH, "utf8");
			const parsed = normalizeSkillManagerStateConfig(JSON.parse(raw) as unknown);
			this.disabledSkills = new Set(parsed.disabledSkills);
			this.selectedSkillSet = parsed.selectedSkillSet;
			this.loadSnapshot = { status: "loaded" };
			this.issues = [];
		} catch (error) {
			const code = errorCode(error);
			this.disabledSkills = new Set();
			this.selectedSkillSet = undefined;
			if (code === "ENOENT") {
				this.loadSnapshot = { status: "missing" };
				this.issues = [];
			} else {
				const message = error instanceof Error ? error.message : String(error);
				this.loadSnapshot = { status: "error", message };
				this.issues = [{ kind: "state-load-error", message }];
			}
		}
		return this.snapshot();
	}

	getSelection(): StoredSkillManagerSelection {
		return {
			disabledSkills: new Set(this.disabledSkills),
			...(this.selectedSkillSet ? { selectedSkillSet: this.selectedSkillSet } : {}),
		};
	}

	setSelection(selection: SkillManagerSelection) {
		this.disabledSkills = new Set(selection.disabledSkills);
		this.selectedSkillSet = selection.selectedSkillSet;
	}

	snapshot(): SkillManagerStateSnapshot {
		return {
			disabledSkills: new Set(this.disabledSkills),
			...(this.selectedSkillSet ? { selectedSkillSet: this.selectedSkillSet } : {}),
			load: { ...this.loadSnapshot },
			issues: [...this.issues],
		};
	}

	persistedState(): SkillManagerState {
		return {
			version: 1,
			disabledSkills: Array.from(this.disabledSkills).sort(),
			...(this.selectedSkillSet ? { selectedSkillSet: this.selectedSkillSet } : {}),
		};
	}

	async save() {
		const state = this.persistedState();
		await writeJsonAtomic(STATE_PATH, `${JSON.stringify(state, null, "\t")}\n`);
		this.loadSnapshot = { status: "loaded" };
		this.issues = [];
		this.pi.appendEntry<SkillManagerState>(STATE_CUSTOM_TYPE, state);
	}

	queueSave(ctx?: ExtensionContext) {
		this.saveQueue = this.saveQueue
			.catch(() => undefined)
			.then(() => this.save())
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				ctx?.ui.notify(`Failed to save skill-manager state: ${message}`, "warning");
			});
		return this.saveQueue;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorCode(error: unknown) {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}
