import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatAliveResult, getAliveAwsServices, parseAliveArgs } from "./aws-cli";
import { getAliveCompletions } from "./completions";

export default function aliveExtension(pi: ExtensionAPI) {
	const showAliveServices = async (args: string, ctx: ExtensionCommandContext) => {
		const options = parseAliveArgs(args);
		try {
			const startedAt = Date.now();
			const result = await getAliveAwsServices(pi, ctx.cwd, options, (command) => {
				ctx.ui.setWidget("aws-alive-progress", ["AWS alive scan in progress", command]);
			});
			const report = formatAliveResult(result);
			ctx.ui.setWidget("aws-alive-progress", undefined);
			pi.sendMessage({ customType: "aws-alive-result", content: report, display: true });
			ctx.ui.notify(
				`AWS alive: ${result.groups.length} service groups found in ${Date.now() - startedAt}ms`,
				"info",
			);
		} catch (error) {
			ctx.ui.setWidget("aws-alive-progress", undefined);
			ctx.ui.notify(`AWS alive failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	pi.registerCommand("aws-alive", {
		description: "List AWS resources alive in your currently authenticated AWS account",
		argumentHint: "[--profile name] [--region region|--all-regions] [service-filter] [--limit n]",
		getArgumentCompletions: (argumentPrefix: string) => getAliveCompletions(pi, process.cwd(), argumentPrefix),
		handler: showAliveServices,
	} as any);

	pi.registerTool({
		name: "aws_alive_services",
		label: "AWS Alive Services",
		description: "List AWS resources alive in the authenticated AWS account using the AWS CLI and SSO profile",
		promptSnippet: "List running/deployed AWS resources in the user's authenticated AWS account using AWS CLI",
		promptGuidelines: [
			"Use aws_alive_services when the user asks which AWS services or resources are currently running in their AWS account.",
		],
		parameters: Type.Object({
			profile: Type.Optional(Type.String({ description: "Optional AWS CLI profile, such as my-sso-profile." })),
			region: Type.Optional(Type.String({ description: "Optional AWS region id, such as us-east-1." })),
			service: Type.Optional(
				Type.String({ description: "Optional service filter, such as ec2, s3, lambda, rds, apigateway, or sqs." }),
			),
			allRegions: Type.Optional(
				Type.Boolean({ description: "Scan every AWS region returned by EC2 describe-regions." }),
			),
			limit: Type.Optional(
				Type.Number({ description: "Maximum resources to show per service group. Default 50, max 500." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await getAliveAwsServices(pi, ctx.cwd, params);
			return {
				content: [{ type: "text", text: formatAliveResult(result) }],
				details: result,
			};
		},
	});
}
