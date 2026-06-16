export type IssueSource = "native" | "parent-section" | "standalone";

export type ChildIssue = {
	number: number;
	title: string;
	state?: "open" | "closed";
	source: IssueSource;
};

export type MattRalphState = {
	name: string;
	taskFile: string;
	status: "active" | "paused" | "completed";
	mode: "implement";
	rootIssue: string;
	parentIssue?: number;
	childIssues: ChildIssue[];
	currentIndex: number;
	iteration: number;
	startedAt: string;
	completedAt?: string;
	maxIterations?: number;
	exitOnComplete?: boolean;
	sessionSuffix?: string;
	orchestratorName?: string;
	archivedAt?: string;
	lastAdvancedAt?: string;
	lastResumedAt?: string;
	initialDirtyStatus?: string;
	ignoredDirtyStatus?: string;
	warnings?: string[];
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

export type TargetDescriptor =
	| { kind: "github"; raw: string; number: number }
	| { kind: "path"; raw: string; path: string }
	| { kind: "text"; raw: string };
