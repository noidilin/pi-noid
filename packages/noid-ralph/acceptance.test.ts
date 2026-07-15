import { describe, expect, it } from "vitest";
import { extractAcceptanceCriteria } from "./acceptance";

describe("acceptance criteria extraction", () => {
	it("prefers structured criteria and assigns stable, duplicate-safe ids", () => {
		expect(
			extractAcceptanceCriteria({
				structured: ["Users can retry failed work", " Users can retry failed work ", "Failures are explained"],
				body: "## Acceptance Criteria\n\n- This fallback must not be used",
			}),
		).toEqual([
			{ id: "users-can-retry-failed-work", text: "Users can retry failed work", source: "structured" },
			{ id: "failures-are-explained", text: "Failures are explained", source: "structured" },
		]);
	});

	it("keeps ids unique when distinct criteria normalize to the same slug", () => {
		expect(extractAcceptanceCriteria({ structured: ["Retry: failed work", "Retry failed work"] })).toEqual([
			{ id: "retry-failed-work", text: "Retry: failed work", source: "structured" },
			{ id: "retry-failed-work-2", text: "Retry failed work", source: "structured" },
		]);
	});

	it("extracts checked and unchecked tasks from acceptance sections at reasonable heading levels", () => {
		expect(
			extractAcceptanceCriteria({
				body: `# Feature

### Acceptance Criteria

- [ ] First behavior works
- [x] Existing behavior remains supported

#### Notes

Nested notes stay in the section but are not criteria.

## Design

- [ ] A task outside the section is ignored`,
			}),
		).toEqual([
			{ id: "first-behavior-works", text: "First behavior works", source: "checklist" },
			{
				id: "existing-behavior-remains-supported",
				text: "Existing behavior remains supported",
				source: "checklist",
			},
		]);
	});

	it("uses list and prose requirements from multiple acceptance sections when no section checklist exists", () => {
		expect(
			extractAcceptanceCriteria({
				body: `## Acceptance Criteria

- The command reports actionable failures.
Plain prose is also a requirement.

## Later

### Acceptance Criteria ###

1. Output remains width-safe.
- the command reports actionable failures.`,
			}),
		).toEqual([
			{
				id: "the-command-reports-actionable-failures",
				text: "The command reports actionable failures.",
				source: "section",
			},
			{
				id: "plain-prose-is-also-a-requirement",
				text: "Plain prose is also a requirement.",
				source: "section",
			},
			{ id: "output-remains-width-safe", text: "Output remains width-safe.", source: "section" },
		]);
	});

	it("falls back to task-list items when there is no valid acceptance heading", () => {
		expect(
			extractAcceptanceCriteria({
				body: `## Acceptance Criteria-ish

- [ ] First fallback requirement
- [X] Second fallback requirement

Acceptance Criteria
- Plain bullets without task boxes are not a fallback`,
			}),
		).toEqual([
			{ id: "first-fallback-requirement", text: "First fallback requirement", source: "checklist" },
			{ id: "second-fallback-requirement", text: "Second fallback requirement", source: "checklist" },
		]);
	});

	it("returns no criteria for criteria-free text", () => {
		expect(extractAcceptanceCriteria({ body: "Implement the requested behavior without a checklist." })).toEqual([]);
	});
});
