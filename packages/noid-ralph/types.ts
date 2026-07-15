export const MATT_RALPH_SCHEMA_VERSION = 3;

export type IssueSource = "native" | "parent-section" | "standalone";
export type TargetSourceKind = "github" | "prd" | "text";

export type AcceptanceCriterion = {
	id: string;
	text: string;
	source: "section" | "checklist" | "structured";
};

export type ResolvedImplementationTarget = {
	key: string;
	source: TargetSourceKind;
	title: string;
	body?: string;
	issueNumber?: number;
	parentIssueNumber?: number;
	state?: "open" | "closed";
	issueSource?: IssueSource;
	acceptanceCriteria: AcceptanceCriterion[];
	acceptanceCriteriaResolved?: boolean;
};

export type ResolvedTargetPlan = {
	root: ResolvedImplementationTarget;
	targets: ResolvedImplementationTarget[];
};

export type ChildIssue = {
	number: number;
	title: string;
	state?: "open" | "closed";
	source: IssueSource;
};

export type OrchestrationChildLink = {
	orchestrationName: string;
	parentIssue: number;
	childIssue: number;
	issueRunIndex: number;
	parentStatePath: string;
};

export type MattRalphState = {
	schemaVersion: typeof MATT_RALPH_SCHEMA_VERSION;
	name: string;
	taskFile: string;
	status: "active" | "paused" | "completed";
	mode: "implement";
	rootIssue: string;
	parentIssue?: number;
	childIssues: ChildIssue[];
	targetPlan: ResolvedTargetPlan;
	currentIndex: number;
	iteration: number;
	startedAt: string;
	completedAt?: string;
	maxIterations?: number;
	exitOnComplete?: boolean;
	sessionSuffix?: string;
	orchestratorName?: string;
	orchestrationChildLink?: OrchestrationChildLink;
	archivedAt?: string;
	lastAdvancedAt?: string;
	lastResumedAt?: string;
	initialDirtyStatus?: string;
	ignoredDirtyStatus?: string;
	warnings?: string[];
};

export type MattRalphStateV2 = Omit<MattRalphState, "schemaVersion" | "targetPlan"> & {
	schemaVersion: 2;
};

export type IssueMetadata = {
	number: number;
	title: string;
	state?: "open" | "closed";
	body?: string;
	url?: string;
	parent?: {
		number: number;
		title?: string;
		state?: "open" | "closed";
		url?: string;
	};
};
