import { describe, expect, it } from "vitest";
import { formatAliveResult, parseAliveArgs } from "./aws-cli";

describe("personal alive AWS CLI helpers", () => {
	it("parses profile, region, service filter, and limit", () => {
		expect(parseAliveArgs("--profile sandbox --region us-east-1 ec2 --limit 5")).toEqual({
			profile: "sandbox",
			region: "us-east-1",
			service: "ec2",
			limit: 5,
		});
	});

	it("accepts positional region and all-region scans", () => {
		expect(parseAliveArgs("us-west-2 lambda --all-regions")).toEqual({
			region: "us-west-2",
			service: "lambda",
			allRegions: true,
		});
	});

	it("formats discovered resources", () => {
		const formatted = formatAliveResult({
			identity: { Account: "123456789012" },
			profile: "sandbox",
			regions: ["us-east-1"],
			groups: [
				{
					service: "ec2",
					label: "EC2 running instances",
					region: "us-east-1",
					resources: ["i-123"],
				},
			],
			errors: [],
		});

		expect(formatted).toContain("# AWS alive resources");
		expect(formatted).toContain("- Account: 123456789012");
		expect(formatted).toContain("- Profile: sandbox");
		expect(formatted).toContain("## us-east-1");
		expect(formatted).toContain("### EC2 running instances (1)");
		expect(formatted).toContain("- i-123");
	});
});
