import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const SERVICE_ITEMS: AutocompleteItem[] = [
	{ value: "apigateway", label: "apigateway", description: "API Gateway REST/HTTP/WebSocket APIs" },
	{ value: "cloudformation", label: "cloudformation", description: "CloudFormation active stacks" },
	{ value: "cloudfront", label: "cloudfront", description: "CloudFront distributions" },
	{ value: "cloudwatch", label: "cloudwatch", description: "CloudWatch alarms and log groups" },
	{ value: "dynamodb", label: "dynamodb", description: "DynamoDB tables" },
	{ value: "ec2", label: "ec2", description: "EC2 running instances" },
	{ value: "ecr", label: "ecr", description: "ECR repositories" },
	{ value: "ecs", label: "ecs", description: "ECS running services and tasks" },
	{ value: "eks", label: "eks", description: "EKS clusters" },
	{ value: "elasticbeanstalk", label: "elasticbeanstalk", description: "Elastic Beanstalk environments" },
	{ value: "elb", label: "elb", description: "Classic/Application/Network Load Balancers" },
	{ value: "events", label: "events", description: "EventBridge rules" },
	{ value: "kms", label: "kms", description: "KMS keys" },
	{ value: "lambda", label: "lambda", description: "Lambda functions" },
	{ value: "rds", label: "rds", description: "RDS available DB instances" },
	{ value: "route53", label: "route53", description: "Route 53 hosted zones" },
	{ value: "s3", label: "s3", description: "S3 buckets" },
	{ value: "secretsmanager", label: "secretsmanager", description: "Secrets Manager active secrets" },
	{ value: "sns", label: "sns", description: "SNS topics" },
	{ value: "sqs", label: "sqs", description: "SQS queues" },
	{ value: "ssm", label: "ssm", description: "SSM managed instances" },
];

const OPTION_ITEMS: AutocompleteItem[] = [
	{ value: "--profile ", label: "--profile", description: "Use a named AWS CLI SSO profile" },
	{ value: "--region ", label: "--region", description: "Scan one AWS region" },
	{ value: "--all-regions ", label: "--all-regions", description: "Scan every EC2-discovered region" },
	{ value: "--limit ", label: "--limit", description: "Limit resources shown per service group" },
];

const COMMON_REGION_ITEMS: AutocompleteItem[] = [
	{ value: "us-east-1", label: "us-east-1", description: "US East (N. Virginia)" },
	{ value: "us-east-2", label: "us-east-2", description: "US East (Ohio)" },
	{ value: "us-west-2", label: "us-west-2", description: "US West (Oregon)" },
	{ value: "eu-west-1", label: "eu-west-1", description: "Europe (Ireland)" },
	{ value: "eu-central-1", label: "eu-central-1", description: "Europe (Frankfurt)" },
	{ value: "ap-northeast-1", label: "ap-northeast-1", description: "Asia Pacific (Tokyo)" },
	{ value: "ap-southeast-1", label: "ap-southeast-1", description: "Asia Pacific (Singapore)" },
	{ value: "ap-southeast-2", label: "ap-southeast-2", description: "Asia Pacific (Sydney)" },
];

const LIMIT_ITEMS: AutocompleteItem[] = [
	{ value: "10", label: "10", description: "Show up to 10 resources per service group" },
	{ value: "50", label: "50", description: "Show up to 50 resources per service group" },
	{ value: "100", label: "100", description: "Show up to 100 resources per service group" },
	{ value: "500", label: "500", description: "Show up to 500 resources per service group" },
];

export async function getAliveCompletions(
	pi: ExtensionAPI,
	cwd: string,
	argumentPrefix: string,
): Promise<AutocompleteItem[] | null> {
	const context = parseCompletionContext(argumentPrefix);
	const previous = context.parts.at(-2);
	if (previous === "--profile" || previous === "-p") {
		return completeCurrent(argumentPrefix, context.current, await getAwsProfiles(pi, cwd));
	}
	if (previous === "--region" || previous === "-r") {
		return completeCurrent(argumentPrefix, context.current, COMMON_REGION_ITEMS);
	}
	if (previous === "--limit") {
		return completeCurrent(argumentPrefix, context.current, LIMIT_ITEMS);
	}

	const completed = new Set(context.hasTrailingSpace ? context.parts : context.parts.slice(0, -1));
	const optionItems = OPTION_ITEMS.filter((item) => !completed.has(item.label));
	const candidates = [...optionItems, ...COMMON_REGION_ITEMS, ...SERVICE_ITEMS].filter((item) =>
		item.label.toLowerCase().startsWith(context.current.toLowerCase()),
	);
	return completeCurrent(argumentPrefix, context.current, candidates);
}

async function getAwsProfiles(pi: ExtensionAPI, cwd: string): Promise<AutocompleteItem[]> {
	const result = await pi.exec("aws", ["configure", "list-profiles"], { cwd, timeout: 5_000 });
	if (result.code !== 0) return [];
	return result.stdout
		.split("\n")
		.map((profile) => profile.trim())
		.filter(Boolean)
		.map((profile) => ({ value: profile, label: profile, description: "AWS CLI profile" }));
}

function completeCurrent(
	argumentPrefix: string,
	current: string,
	items: AutocompleteItem[],
): AutocompleteItem[] | null {
	const base = argumentPrefix.slice(0, argumentPrefix.length - current.length);
	const matches = items
		.filter((item) => item.label.toLowerCase().startsWith(current.toLowerCase()))
		.map((item) => ({
			...item,
			value: `${base}${item.value}${item.value.endsWith(" ") ? "" : " "}`,
		}));
	return matches.length > 0 ? matches : null;
}

function parseCompletionContext(argumentPrefix: string) {
	const hasTrailingSpace = /\s$/.test(argumentPrefix);
	const trimmed = argumentPrefix.trim();
	const parts = trimmed ? trimmed.split(/\s+/) : [];
	const current = hasTrailingSpace ? "" : (parts.at(-1) ?? "");
	return { hasTrailingSpace, parts, current };
}
