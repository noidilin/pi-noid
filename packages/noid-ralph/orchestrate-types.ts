export type OrchestrateChild = {
	number: number;
	title: string;
	state?: "open" | "closed";
	body?: string;
	url?: string;
	source: "native" | "parent-section" | "standalone";
	order: number;
};

export type DependencyRef = {
	raw: string;
	issue?: number;
	path?: string;
	resolvedIssue?: number;
	scope: "sibling" | "external" | "unresolved";
	status: "satisfied" | "blocking" | "unknown";
	reason?: string;
};

export type OrchestratePlan = {
	parent: { number: number; title: string; url?: string };
	allChildren: OrchestrateChild[];
	openChildren: OrchestrateChild[];
	skippedClosed: OrchestrateChild[];
	dependenciesByIssue: Record<number, DependencyRef[]>;
	plannedOrder: OrchestrateChild[];
	blockers: DependencyRef[];
	cycles: number[][];
	valid: boolean;
};

export type ResolveExternalIssue = (
	issue: number,
) => Promise<{ state?: "open" | "closed"; title?: string } | undefined>;

export type OrchestrateStatus = "planned" | "active" | "paused" | "completed" | "failed" | "stopped";

export type OrchestrateIssueRun = {
	issue: number;
	title: string;
	status: "pending" | "running" | "completed" | "skipped" | "failed";
	sessionName?: string;
	startedAt?: string;
	completedAt?: string;
	workerLaunchedAt?: string;
	workerExitedAt?: string;
	workerExitCode?: number;
	workerScript?: string;
	ralphStartedAt?: string;
	ralphCompletedAt?: string;
	initialDirtyStatus?: string;
	ignoredDirtyStatus?: string;
	headBefore?: string;
	headAfter?: string;
	commits?: string[];
	error?: string;
};

export type OrchestrateState = {
	name: string;
	parentIssue: number;
	parentTitle: string;
	parentUrl?: string;
	status: OrchestrateStatus;
	startedAt: string;
	completedAt?: string;
	issueTimeoutMs: number;
	currentIndex: number;
	plan: OrchestratePlan;
	issueRuns: OrchestrateIssueRun[];
	herdr?: {
		workspaceId?: string;
		tabId?: string;
		paneId?: string;
	};
	stopRequested?: boolean;
	failureReason?: string;
};
