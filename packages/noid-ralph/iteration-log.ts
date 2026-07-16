import { readFile } from "node:fs/promises";
import { iterationPathFor, writeJsonAtomically } from "./ralph-state-storage";
import type { AcceptanceCriterion, TargetSourceKind } from "./types";

export type IterationOutcome = "running" | "accepted" | "rejected" | "failed" | "interrupted";

export type RalphIterationRecord = {
	schemaVersion: 1;
	sessionName: string;
	iteration: number;
	targetKey: string;
	targetTitle: string;
	source: TargetSourceKind;
	startedAt: string;
	endedAt?: string;
	outcome: IterationOutcome;
	headBefore?: string;
	headAfter?: string;
	commits?: string[];
	acceptanceCriteria: AcceptanceCriterion[];
	failureReason?: string;
};

export type OpenIterationRecordInput = Pick<
	RalphIterationRecord,
	"sessionName" | "iteration" | "targetKey" | "targetTitle" | "source" | "startedAt" | "acceptanceCriteria"
> &
	Partial<Pick<RalphIterationRecord, "headBefore">>;

export type OpenedIterationRecord = {
	path: string;
	record: RalphIterationRecord;
};

export type CloseIterationRecordInput = {
	sessionName: string;
	iteration: number;
	targetKey: string;
	outcome: Exclude<IterationOutcome, "running">;
	endedAt: string;
	headAfter?: string;
	commits?: string[];
	failureReason?: string;
};

export async function openIterationRecord(
	cwd: string,
	input: OpenIterationRecordInput,
): Promise<OpenedIterationRecord> {
	const record: RalphIterationRecord = {
		schemaVersion: 1,
		...input,
		outcome: "running",
	};
	const file = iterationPathFor(cwd, input.sessionName, input.iteration, input.targetKey);
	try {
		const existing = await readIterationRecord(cwd, input.sessionName, input.iteration, input.targetKey);
		if (existing.outcome === "running") throw new Error(`Iteration attempt is already running: ${file}`);
		throw new Error(`Iteration attempt already exists with outcome ${existing.outcome}: ${file}`);
	} catch (error) {
		if (!isFileNotFound(error)) throw error;
	}
	await writeJsonAtomically(file, record);
	return { path: file, record };
}

export async function closeIterationRecord(
	cwd: string,
	input: CloseIterationRecordInput,
): Promise<RalphIterationRecord> {
	const record = await readIterationRecord(cwd, input.sessionName, input.iteration, input.targetKey);
	if (record.outcome !== "running") {
		throw new Error(`Cannot close iteration attempt with outcome ${record.outcome}.`);
	}
	const closed: RalphIterationRecord = {
		...record,
		outcome: input.outcome,
		endedAt: input.endedAt,
		headAfter: input.headAfter,
		commits: input.commits,
		failureReason: input.failureReason,
	};
	await writeJsonAtomically(iterationPathFor(cwd, input.sessionName, input.iteration, input.targetKey), closed);
	return closed;
}

export async function readIterationRecord(
	cwd: string,
	sessionName: string,
	iteration: number,
	targetKey: string,
): Promise<RalphIterationRecord> {
	const file = iterationPathFor(cwd, sessionName, iteration, targetKey);
	const value: unknown = JSON.parse(await readFile(file, "utf8"));
	if (!isIterationRecord(value)) throw new Error(`Malformed Ralph iteration record in ${file}.`);
	return value;
}

function isIterationRecord(value: unknown): value is RalphIterationRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<RalphIterationRecord>;
	return (
		record.schemaVersion === 1 &&
		typeof record.sessionName === "string" &&
		typeof record.iteration === "number" &&
		typeof record.targetKey === "string" &&
		typeof record.targetTitle === "string" &&
		(record.source === "github" || record.source === "prd" || record.source === "text") &&
		typeof record.startedAt === "string" &&
		["running", "accepted", "rejected", "failed", "interrupted"].includes(record.outcome ?? "") &&
		optionalString(record.endedAt) &&
		optionalString(record.headBefore) &&
		optionalString(record.headAfter) &&
		(record.commits === undefined ||
			(Array.isArray(record.commits) && record.commits.every((commit) => typeof commit === "string"))) &&
		optionalString(record.failureReason) &&
		Array.isArray(record.acceptanceCriteria) &&
		record.acceptanceCriteria.every(isAcceptanceCriterion)
	);
}

function isAcceptanceCriterion(value: unknown): value is AcceptanceCriterion {
	if (!value || typeof value !== "object") return false;
	const criterion = value as Partial<AcceptanceCriterion>;
	return (
		typeof criterion.id === "string" &&
		typeof criterion.text === "string" &&
		(criterion.source === "section" || criterion.source === "checklist" || criterion.source === "structured")
	);
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isFileNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
