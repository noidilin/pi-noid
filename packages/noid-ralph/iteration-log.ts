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
	await writeJsonAtomically(file, record);
	return { path: file, record };
}
