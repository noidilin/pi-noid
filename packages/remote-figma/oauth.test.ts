import { describe, expect, it } from "vitest";
import { buildCallbackUrl } from "./oauth";

// Regression guard. Figma accepts a literal 127.0.0.1 redirect_uri at dynamic registration and at the
// authorize step, then rejects the token exchange with invalid_grant, so the advertised redirect_uri has
// to spell the host "localhost" even though the listener itself binds 127.0.0.1.
describe("buildCallbackUrl", () => {
	it("advertises localhost, never the literal loopback IP", () => {
		expect(buildCallbackUrl(52221)).toBe("http://localhost:52221/callback");
		expect(buildCallbackUrl(52221)).not.toContain("127.0.0.1");
	});

	it("carries the resolved port so a random free port round-trips", () => {
		expect(buildCallbackUrl(0)).toBe("http://localhost:0/callback");
		expect(new URL(buildCallbackUrl(65535)).port).toBe("65535");
	});
});
