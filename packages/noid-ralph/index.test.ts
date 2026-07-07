import { describe, expect, it } from "vitest";
import { hasGitCommit, protectRalphGitCommitCommand } from "./index";

describe("Ralph git commit protection", () => {
	it("detects and wraps git commit commands", () => {
		const command = 'git add . && git commit -m "work"';
		const protectedCommand = protectRalphGitCommitCommand(command);

		expect(hasGitCommit(command)).toBe(true);
		expect(protectedCommand).toBe(
			'git add . && { git restore --staged -- .ralph 2>/dev/null || true; git rm --cached -r --ignore-unmatch .ralph 2>/dev/null || true; } && git commit -m "work"',
		);
	});

	it("leaves non-commit git commands unchanged", () => {
		const command = "git status --short";
		expect(hasGitCommit(command)).toBe(false);
		expect(protectRalphGitCommitCommand(command)).toBe(command);
	});
});
