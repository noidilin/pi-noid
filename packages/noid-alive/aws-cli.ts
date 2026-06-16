import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type AliveOptions = {
	profile?: string;
	region?: string;
	service?: string;
	allRegions?: boolean;
	limit?: number;
};

export type AwsIdentity = {
	Account?: string;
	Arn?: string;
	UserId?: string;
};

export type AliveServiceGroup = {
	service: string;
	label: string;
	region: string;
	resources: string[];
};

export type AliveResult = {
	identity?: AwsIdentity;
	profile?: string;
	regions: string[];
	groups: AliveServiceGroup[];
	errors: string[];
};

type ExecResult = {
	code: number;
	stdout: string;
	stderr: string;
};

type ExecAws = (args: string[], timeout?: number, outputJson?: boolean) => Promise<ExecResult>;

const DEFAULT_REGION = "us-east-1";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const GLOBAL_PROBES = [
	{
		service: "s3",
		label: "S3 buckets",
		args: ["s3api", "list-buckets", "--query", "Buckets[].Name"],
	},
	{
		service: "cloudfront",
		label: "CloudFront distributions",
		args: ["cloudfront", "list-distributions", "--query", "DistributionList.Items[].Id"],
	},
	{
		service: "route53",
		label: "Route 53 hosted zones",
		args: ["route53", "list-hosted-zones", "--query", "HostedZones[].Name"],
	},
] as const;

const REGIONAL_PROBES = [
	{
		service: "apigateway",
		label: "API Gateway REST APIs",
		args: ["apigateway", "get-rest-apis", "--query", "items[].name"],
	},
	{
		service: "apigatewayv2",
		label: "API Gateway HTTP/WebSocket APIs",
		args: ["apigatewayv2", "get-apis", "--query", "Items[].Name"],
	},
	{
		service: "cloudformation",
		label: "CloudFormation active stacks",
		args: ["cloudformation", "describe-stacks", "--query", "Stacks[?StackStatus!='DELETE_COMPLETE'].StackName"],
	},
	{
		service: "cloudwatch",
		label: "CloudWatch metric alarms",
		args: ["cloudwatch", "describe-alarms", "--query", "MetricAlarms[].AlarmName"],
	},
	{
		service: "logs",
		label: "CloudWatch log groups",
		args: ["logs", "describe-log-groups", "--query", "logGroups[].logGroupName"],
	},
	{
		service: "dynamodb",
		label: "DynamoDB tables",
		args: ["dynamodb", "list-tables", "--query", "TableNames"],
	},
	{
		service: "ec2",
		label: "EC2 running instances",
		args: [
			"ec2",
			"describe-instances",
			"--filters",
			"Name=instance-state-name,Values=running",
			"--query",
			"Reservations[].Instances[].InstanceId",
		],
	},
	{
		service: "ecr",
		label: "ECR repositories",
		args: ["ecr", "describe-repositories", "--query", "repositories[].repositoryName"],
	},
	{
		service: "eks",
		label: "EKS clusters",
		args: ["eks", "list-clusters", "--query", "clusters"],
	},
	{
		service: "elasticbeanstalk",
		label: "Elastic Beanstalk environments",
		args: [
			"elasticbeanstalk",
			"describe-environments",
			"--query",
			"Environments[?Status!='Terminated'].EnvironmentName",
		],
	},
	{
		service: "elb",
		label: "Classic Load Balancers",
		args: ["elb", "describe-load-balancers", "--query", "LoadBalancerDescriptions[].LoadBalancerName"],
	},
	{
		service: "elbv2",
		label: "Application/Network Load Balancers",
		args: ["elbv2", "describe-load-balancers", "--query", "LoadBalancers[].LoadBalancerName"],
	},
	{
		service: "events",
		label: "EventBridge rules",
		args: ["events", "list-rules", "--query", "Rules[].Name"],
	},
	{
		service: "kms",
		label: "KMS keys",
		args: ["kms", "list-keys", "--query", "Keys[].KeyId"],
	},
	{
		service: "lambda",
		label: "Lambda functions",
		args: ["lambda", "list-functions", "--query", "Functions[].FunctionName"],
	},
	{
		service: "rds",
		label: "RDS available DB instances",
		args: [
			"rds",
			"describe-db-instances",
			"--query",
			"DBInstances[?DBInstanceStatus=='available'].DBInstanceIdentifier",
		],
	},
	{
		service: "secretsmanager",
		label: "Secrets Manager active secrets",
		args: ["secretsmanager", "list-secrets", "--query", "SecretList[?DeletedDate==null].Name"],
	},
	{
		service: "sns",
		label: "SNS topics",
		args: ["sns", "list-topics", "--query", "Topics[].TopicArn"],
	},
	{
		service: "sqs",
		label: "SQS queues",
		args: ["sqs", "list-queues", "--query", "QueueUrls"],
	},
	{
		service: "ssm",
		label: "SSM managed instances",
		args: ["ssm", "describe-instance-information", "--query", "InstanceInformationList[].InstanceId"],
	},
] as const;

export function parseAliveArgs(args: string): AliveOptions {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const options: AliveOptions = {};
	const serviceParts: string[] = [];
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if ((part === "--profile" || part === "-p") && parts[index + 1]) {
			options.profile = parts[index + 1];
			index += 1;
			continue;
		}
		if ((part === "--region" || part === "-r") && parts[index + 1]) {
			options.region = parts[index + 1];
			index += 1;
			continue;
		}
		if (part === "--all-regions") {
			options.allRegions = true;
			continue;
		}
		if (part === "--limit" && parts[index + 1]) {
			options.limit = Number(parts[index + 1]);
			index += 1;
			continue;
		}
		if (isAwsRegionId(part)) {
			options.region = part;
			continue;
		}
		serviceParts.push(part);
	}
	options.service = serviceParts.join(" ") || undefined;
	return options;
}

export async function getAliveAwsServices(
	pi: ExtensionAPI,
	cwd: string,
	options: AliveOptions,
	onProgress?: (command: string) => void,
): Promise<AliveResult> {
	const execAws = createAwsExec(pi, cwd, options, onProgress);
	const errors: string[] = [];
	const identity = await getIdentity(execAws, errors);
	const regions = await resolveRegions(execAws, options, errors);
	const groups: AliveServiceGroup[] = [];

	for (const probe of GLOBAL_PROBES) {
		if (!shouldProbe(probe.service, probe.label, options.service)) continue;
		const resources = await probeJsonArray(execAws, [...probe.args], errors);
		if (resources.length > 0) {
			groups.push(limitGroup({ service: probe.service, label: probe.label, region: "global", resources }, options));
		}
	}

	for (const region of regions) {
		for (const probe of REGIONAL_PROBES) {
			if (!shouldProbe(probe.service, probe.label, options.service)) continue;
			const resources = await probeJsonArray(execAws, [...probe.args, "--region", region], errors);
			if (resources.length > 0) {
				groups.push(limitGroup({ service: probe.service, label: probe.label, region, resources }, options));
			}
		}
		if (shouldProbe("ecs", "ECS running services and tasks", options.service)) {
			const ecsResources = await probeEcs(execAws, region, errors);
			if (ecsResources.length > 0) {
				groups.push(
					limitGroup(
						{ service: "ecs", label: "ECS running services/tasks", region, resources: ecsResources },
						options,
					),
				);
			}
		}
	}

	return { identity, profile: options.profile, regions, groups, errors };
}

export function formatAliveResult(result: AliveResult): string {
	const identity = result.identity?.Account ? result.identity.Account : "unknown";
	const profile = result.profile ?? "default/profile from environment";
	const totalResources = result.groups.reduce((sum, group) => sum + group.resources.length, 0);
	const lines = [
		"# AWS alive resources",
		"",
		`- Account: ${identity}`,
		`- Profile: ${profile}`,
		`- Regions scanned: ${result.regions.join(", ")}`,
		`- Service groups: ${result.groups.length}`,
		`- Resources shown: ${totalResources}`,
		"",
	];

	if (result.groups.length === 0) {
		lines.push("No matching running/deployed AWS resources found.");
	} else {
		for (const region of orderedRegions(result.groups)) {
			lines.push(`## ${region === "global" ? "Global services" : region}`, "");
			for (const group of result.groups.filter((item) => item.region === region)) {
				lines.push(`### ${group.label} (${group.resources.length})`);
				for (const resource of group.resources) lines.push(`- ${formatResource(resource)}`);
				lines.push("");
			}
		}
	}

	if (result.errors.length > 0) {
		lines.push("## Probe errors", "");
		for (const error of result.errors.slice(0, 10)) lines.push(`- ${error}`);
	}
	return lines.join("\n").trimEnd();
}

function createAwsExec(
	pi: ExtensionAPI,
	cwd: string,
	options: AliveOptions,
	onProgress?: (command: string) => void,
): ExecAws {
	return (args, timeout = 20_000, outputJson = true) => {
		const profileArgs = options.profile ? ["--profile", options.profile] : [];
		const outputArgs = outputJson ? ["--output", "json"] : [];
		const fullArgs = [...profileArgs, ...args, ...outputArgs];
		onProgress?.(`aws ${fullArgs.join(" ")}`);
		return pi.exec("aws", fullArgs, { cwd, timeout });
	};
}

async function getIdentity(execAws: ExecAws, errors: string[]): Promise<AwsIdentity | undefined> {
	const result = await execAws(["sts", "get-caller-identity"], 10_000);
	if (result.code !== 0) {
		errors.push(`sts get-caller-identity: ${cleanError(result.stderr)}`);
		return undefined;
	}
	return parseJson<AwsIdentity>(result.stdout, errors, "sts get-caller-identity");
}

async function resolveRegions(execAws: ExecAws, options: AliveOptions, errors: string[]): Promise<string[]> {
	if (options.allRegions) {
		const regions = await probeJsonArray(
			execAws,
			["ec2", "describe-regions", "--query", "Regions[].RegionName"],
			errors,
		);
		if (regions.length > 0) return regions;
	}
	if (options.region) return [options.region];

	const result = await execAws(["configure", "get", "region"], 5_000, false);
	const configuredRegion = result.code === 0 ? result.stdout.trim().replace(/^"|"$/g, "") : "";
	return [configuredRegion || DEFAULT_REGION];
}

async function probeJsonArray(execAws: ExecAws, args: string[], errors: string[]): Promise<string[]> {
	const result = await execAws(args);
	const probeName = args.slice(0, 2).join(" ");
	if (result.code !== 0) {
		errors.push(`${probeName}: ${cleanError(result.stderr)}`);
		return [];
	}
	const parsed = parseJson<unknown>(result.stdout, errors, probeName);
	return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
}

async function probeEcs(execAws: ExecAws, region: string, errors: string[]): Promise<string[]> {
	const clusters = await probeJsonArray(
		execAws,
		["ecs", "list-clusters", "--query", "clusterArns", "--region", region],
		errors,
	);
	const resources: string[] = [];
	for (const cluster of clusters) {
		const services = await probeJsonArray(
			execAws,
			["ecs", "list-services", "--cluster", cluster, "--query", "serviceArns", "--region", region],
			errors,
		);
		if (services.length > 0) resources.push(...services.map((service) => `${cluster} service ${service}`));
		const tasks = await probeJsonArray(
			execAws,
			[
				"ecs",
				"list-tasks",
				"--cluster",
				cluster,
				"--desired-status",
				"RUNNING",
				"--query",
				"taskArns",
				"--region",
				region,
			],
			errors,
		);
		resources.push(...tasks.map((task) => `${cluster} task ${task}`));
	}
	return resources;
}

function orderedRegions(groups: AliveServiceGroup[]): string[] {
	const regions = [...new Set(groups.map((group) => group.region))];
	return regions.sort((left, right) => {
		if (left === "global") return -1;
		if (right === "global") return 1;
		return left.localeCompare(right);
	});
}

function formatResource(resource: string): string {
	const ecs = resource.match(/^arn:aws:ecs:[^:]+:\d+:cluster\/([^\s]+) (service|task) (arn:aws:ecs:[^\s]+)$/);
	if (ecs) return `${ecs[2]} ${lastArnSegment(ecs[3])} _(cluster: ${ecs[1]})_`;
	if (resource.startsWith("arn:")) return `${lastArnSegment(resource)} _(${resource})_`;
	if (/^https?:\/\//.test(resource)) return resource.split("/").filter(Boolean).at(-1) ?? resource;
	return resource;
}

function lastArnSegment(arn: string): string {
	return arn.split(/[/:]/).filter(Boolean).at(-1) ?? arn;
}

function parseJson<T>(stdout: string, errors: string[], label: string): T | undefined {
	try {
		return JSON.parse(stdout) as T;
	} catch {
		errors.push(`${label}: invalid JSON output`);
		return undefined;
	}
}

function limitGroup(group: AliveServiceGroup, options: AliveOptions): AliveServiceGroup {
	const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
	return { ...group, resources: group.resources.slice(0, limit) };
}

function shouldProbe(service: string, label: string, filter: string | undefined): boolean {
	if (!filter) return true;
	const normalized = filter.toLowerCase();
	return service.includes(normalized) || label.toLowerCase().includes(normalized);
}

function isAwsRegionId(value: string): boolean {
	return /^[a-z]{2}-[a-z]+-\d$/.test(value);
}

function cleanError(stderr: string): string {
	return stderr.trim().split("\n").at(-1) || "command failed";
}
