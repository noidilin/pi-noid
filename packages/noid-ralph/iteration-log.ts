import { readFile } from "node:fs/promises";
import type { ChildRunProgress } from "./child-run";
import { iterationPathFor, writeJsonAtomically } from "./ralph-state-storage";
import type { AcceptanceCriterion, TargetCompletionEvidence, TargetSourceKind, ValidationEvidence } from "./types";

export type IterationOutcome = "running" | "accepted" | "rejected" | "failed" | "interrupted";

const MAX_PANE_TAIL_LENGTH = 4_000;

export type ChildRunIterationEvidence = {
	workerScript?: string;
	workerLaunchedAt?: string;
	workerExitedAt?: string;
	workerExitCode?: number;
	paneTail?: string;
};

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
	completionEvidence?: TargetCompletionEvidence;
	rejectionReasons?: string[];
	validation?: ValidationEvidence[];
	childRun?: ChildRunIterationEvidence;
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

export type UpdateIterationRecordInput = {
	sessionName: string;
	iteration: number;
	targetKey: string;
	headAfter?: string;
	commits?: string[];
	validation?: ValidationEvidence[];
	childRun?: ChildRunIterationEvidence;
};

export type CloseIterationRecordInput = {
	sessionName: string;
	iteration: number;
	targetKey: string;
	outcome: Exclude<IterationOutcome, "running">;
	endedAt: string;
	headAfter?: string;
	commits?: string[];
	completionEvidence?: TargetCompletionEvidence;
	rejectionReasons?: string[];
	validation?: ValidationEvidence[];
	childRun?: ChildRunIterationEvidence;
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

export async function updateIterationRecord(
	cwd: string,
	input: UpdateIterationRecordInput,
): Promise<RalphIterationRecord> {
	const record = await readIterationRecord(cwd, input.sessionName, input.iteration, input.targetKey);
	if (record.outcome !== "running") {
		throw new Error(`Cannot update iteration attempt with outcome ${record.outcome}.`);
	}
	const updated: RalphIterationRecord = {
		...record,
		headAfter: input.headAfter ?? record.headAfter,
		commits: input.commits ?? record.commits,
		validation: input.validation ?? record.validation,
		childRun: mergeChildRunEvidence(record.childRun, input.childRun),
	};
	await writeJsonAtomically(iterationPathFor(cwd, input.sessionName, input.iteration, input.targetKey), updated);
	return updated;
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
		headAfter: input.headAfter ?? record.headAfter,
		commits: input.commits ?? record.commits,
		completionEvidence: input.completionEvidence ?? record.completionEvidence,
		rejectionReasons: input.rejectionReasons ?? record.rejectionReasons,
		validation: input.validation ?? record.validation,
		childRun: mergeChildRunEvidence(record.childRun, input.childRun),
		failureReason: input.failureReason ?? record.failureReason,
	};
	await writeJsonAtomically(iterationPathFor(cwd, input.sessionName, input.iteration, input.targetKey), closed);
	return closed;
}

export async function persistChildRunProgress(
	cwd: string,
	identity: { orchestrationName: string; index: number; issue: number; title: string },
	progress: ChildRunProgress,
): Promise<void> {
	const recordIdentity = {
		sessionName: identity.orchestrationName,
		iteration: identity.index + 1,
		targetKey: `github:${identity.issue}`,
	};
	if (progress.type === "started") {
		if (identity.index > 0) {
			try {
				const previous = await readIterationRecord(
					cwd,
					recordIdentity.sessionName,
					recordIdentity.iteration - 1,
					recordIdentity.targetKey,
				);
				if (previous.outcome === "running") {
					await closeIterationRecord(cwd, {
						...recordIdentity,
						iteration: recordIdentity.iteration - 1,
						outcome: "interrupted",
						endedAt: progress.facts.startedAt,
						failureReason: `Superseded by child-run retry ${recordIdentity.iteration}.`,
					});
				}
			} catch (error) {
				if (!isFileNotFound(error)) throw error;
			}
		}
		await openIterationRecord(cwd, {
			...recordIdentity,
			targetTitle: identity.title,
			source: "github",
			startedAt: progress.facts.startedAt,
			headBefore: progress.facts.headBefore,
			acceptanceCriteria: [],
		});
		return;
	}
	if (progress.type === "workerScriptWritten") {
		await updateIterationRecord(cwd, { ...recordIdentity, childRun: { workerScript: progress.facts.workerScript } });
		return;
	}
	if (progress.type === "workerLaunched") {
		await updateIterationRecord(cwd, {
			...recordIdentity,
			childRun: { workerLaunchedAt: progress.facts.workerLaunchedAt },
		});
		return;
	}
	if (progress.type === "workerExited") {
		await updateIterationRecord(cwd, {
			...recordIdentity,
			childRun: {
				workerExitedAt: progress.facts.workerExitedAt,
				workerExitCode: progress.facts.workerExitCode,
			},
		});
		return;
	}
	if (progress.type === "completed") {
		await closeIterationRecord(cwd, {
			...recordIdentity,
			outcome: "accepted",
			endedAt: progress.facts.completedAt,
			headAfter: progress.facts.headAfter,
			commits: progress.facts.commits,
		});
		return;
	}
	if (progress.type === "failed") {
		try {
			await readIterationRecord(cwd, recordIdentity.sessionName, recordIdentity.iteration, recordIdentity.targetKey);
		} catch (error) {
			if (!isFileNotFound(error)) throw error;
			await openIterationRecord(cwd, {
				...recordIdentity,
				targetTitle: identity.title,
				source: "github",
				startedAt: progress.facts.startedAt ?? progress.facts.completedAt ?? "unknown",
				headBefore: progress.facts.headBefore,
				acceptanceCriteria: [],
			});
		}
		await closeIterationRecord(cwd, {
			...recordIdentity,
			outcome: "failed",
			endedAt: progress.facts.completedAt ?? progress.facts.workerExitedAt ?? progress.facts.startedAt ?? "unknown",
			headAfter: progress.facts.headAfter,
			commits: progress.facts.commits,
			childRun: { paneTail: progress.diagnostics.paneTail },
			failureReason: progress.reason,
		});
	}
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
		(record.completionEvidence === undefined || isTargetCompletionEvidence(record.completionEvidence)) &&
		optionalStringArray(record.rejectionReasons) &&
		(record.validation === undefined || isValidationEvidenceArray(record.validation)) &&
		(record.childRun === undefined || isChildRunIterationEvidence(record.childRun)) &&
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

function isTargetCompletionEvidence(value: unknown): value is TargetCompletionEvidence {
	if (!value || typeof value !== "object") return false;
	const evidence = value as Partial<TargetCompletionEvidence>;
	return (
		typeof evidence.summary === "string" &&
		Array.isArray(evidence.criteria) &&
		evidence.criteria.every(
			(criterion) =>
				Boolean(criterion) &&
				typeof criterion === "object" &&
				typeof criterion.criterionId === "string" &&
				typeof criterion.evidence === "string",
		) &&
		isValidationEvidenceArray(evidence.validation) &&
		typeof evidence.commit === "string" &&
		typeof evidence.notesUpdated === "boolean"
	);
}

function isValidationEvidenceArray(value: unknown): value is ValidationEvidence[] {
	return (
		Array.isArray(value) &&
		value.every(
			(item) =>
				Boolean(item) &&
				typeof item === "object" &&
				typeof item.command === "string" &&
				typeof item.outcome === "string",
		)
	);
}

function isChildRunIterationEvidence(value: unknown): value is ChildRunIterationEvidence {
	if (!value || typeof value !== "object") return false;
	const childRun = value as Partial<ChildRunIterationEvidence>;
	return (
		optionalString(childRun.workerScript) &&
		optionalString(childRun.workerLaunchedAt) &&
		optionalString(childRun.workerExitedAt) &&
		(childRun.workerExitCode === undefined || typeof childRun.workerExitCode === "number") &&
		optionalString(childRun.paneTail) &&
		(childRun.paneTail?.length ?? 0) <= MAX_PANE_TAIL_LENGTH
	);
}

function mergeChildRunEvidence(
	current: ChildRunIterationEvidence | undefined,
	update: ChildRunIterationEvidence | undefined,
): ChildRunIterationEvidence | undefined {
	if (!update) return current;
	return {
		...current,
		...update,
		...(update.paneTail === undefined ? {} : { paneTail: boundedPaneTail(update.paneTail) }),
	};
}

function boundedPaneTail(value: string | undefined): string | undefined {
	return value?.slice(-MAX_PANE_TAIL_LENGTH);
}

function optionalStringArray(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isFileNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
