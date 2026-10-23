import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { PROFILE_CUSTOM_TYPE } from "./paths";
import { sortedNames } from "./profile-policy";

export type SessionProfile =
	| { status: "unbound" }
	| { status: "selected"; profileName: string }
	| { status: "locked"; profileName: string; resolvedGlobalSkills: string[] };

export function reconstructProfile(branch: readonly SessionEntry[]): {
	state: SessionProfile;
	hasHistory: boolean;
	diagnostics: string[];
} {
	let state: SessionProfile = { status: "unbound" };
	const diagnostics: string[] = [];
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== PROFILE_CUSTOM_TYPE) continue;
		const data = entry.data as
			| { version?: unknown; status?: unknown; profileName?: unknown; resolvedGlobalSkills?: unknown }
			| undefined;
		if (
			data?.version !== 1 ||
			typeof data.profileName !== "string" ||
			!data.profileName ||
			(data.status !== "selected" && data.status !== "locked") ||
			(data.status === "locked" &&
				(!Array.isArray(data.resolvedGlobalSkills) ||
					!data.resolvedGlobalSkills.every((x) => typeof x === "string")))
		) {
			diagnostics.push("Invalid session profile entry; using safe fallback");
			state = { status: "locked", profileName: "fallback", resolvedGlobalSkills: [] };
			continue;
		}
		state =
			data.status === "selected"
				? { status: "selected", profileName: data.profileName }
				: {
						status: "locked",
						profileName: data.profileName,
						resolvedGlobalSkills: sortedNames(data.resolvedGlobalSkills as string[]),
					};
	}
	return {
		state,
		hasHistory: branch.some((entry) => entry.type === "message" || entry.type === "custom_message"),
		diagnostics,
	};
}

export function selectProfile(state: SessionProfile, name: string): { status: "selected"; profileName: string } {
	if (state.status === "locked") throw new Error("Profile locked; start a new session to change profiles.");
	return { status: "selected", profileName: name };
}

export function lockProfile(
	name: string,
	names: readonly string[],
): { status: "locked"; profileName: string; resolvedGlobalSkills: string[] } {
	return { status: "locked", profileName: name, resolvedGlobalSkills: sortedNames(names) };
}

export function persistedProfile(state: Exclude<SessionProfile, { status: "unbound" }>) {
	return { version: 1 as const, ...state };
}
