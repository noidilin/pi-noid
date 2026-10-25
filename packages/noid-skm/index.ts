import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runCreationFlow } from "./creation-flow";
import {
	installSkillManagerFooter,
	refreshSkillFooterThinkingLevel,
	requestSkillFooterRender,
	setSkillFooterThinkingLevel,
} from "./footer";
import { GroupsStore } from "./groups-store";
import { PROFILE_CUSTOM_TYPE } from "./paths";
import { chooseProfile, resolveProfile } from "./profile-policy";
import { ProfilesStore } from "./profiles-store";
import {
	lockProfile,
	persistedProfile,
	reconstructProfile,
	type SessionProfile,
	selectProfile,
} from "./session-profile";
import { filterSkills } from "./skill-filter";
import { getSkillItems } from "./skills";

const CREATE_GROUP = "Create group…";
const CREATE_PROFILE = "Create profile…";
const SET_DEFAULT = "Set default…";
const SHOW_DOCTOR = "Doctor";

export default function skillManagerExtension(pi: ExtensionAPI) {
	const profiles = new ProfilesStore();
	const groups = new GroupsStore();
	let session: SessionProfile = { status: "unbound" };
	let diagnostics: string[] = [];
	let hasHistory = false;
	let statusText = "skills: loading";

	pi.registerFlag("skill-profile", { description: "Skill profile for a new session", type: "string" });

	function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" = "info") {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else pi.sendMessage({ customType: "skill-manager-status", content: text, display: true });
	}

	function candidate() {
		return session.status === "unbound"
			? chooseProfile(profiles.snapshot().config, pi.getFlag("skill-profile"))
			: { name: session.profileName, diagnostics: [] };
	}

	function refresh() {
		const selected = candidate();
		const name = session.status === "unbound" ? selected.name : session.profileName;
		const unhealthy =
			profiles.snapshot().readOnly ||
			groups.snapshot().readOnly ||
			diagnostics.length ||
			selected.diagnostics.length ||
			name === "fallback";
		statusText = `skills: ${name} · ${session.status === "locked" ? "locked" : "open"}${unhealthy ? " ⚠" : ""}`;
		requestSkillFooterRender();
	}

	async function load(skills = getSkillItems(pi)) {
		await Promise.all([profiles.load(skills), groups.load()]);
		refresh();
	}

	function append(state: SessionProfile) {
		session = state;
		if (state.status !== "unbound") pi.appendEntry(PROFILE_CUSTOM_TYPE, persistedProfile(state));
		refresh();
	}

	function lock(ctx: ExtensionContext, skills = getSkillItems(pi)) {
		if (session.status === "locked") return;
		const choice = candidate();
		const name = choice.name;
		diagnostics.push(...choice.diagnostics);
		if (name !== "fallback" && !profiles.snapshot().config.profiles[name])
			diagnostics.push(`Selected profile no longer exists: ${name}; using core skills`);
		const profileConfig = profiles.snapshot().config;
		const effectiveProfiles = groups.snapshot().readOnly ? { ...profileConfig, profiles: {} } : profileConfig;
		const resolution = resolveProfile(effectiveProfiles, groups.snapshot().config, name, skills);
		diagnostics.push(...resolution.unknownGroups.map((group) => `Unknown profile group: ${group}`));
		diagnostics.push(...resolution.unknownSkills.map((member) => `Uninstalled profile member: ${member}`));
		append(lockProfile(name, resolution.names));
		if (hasHistory) notify(ctx, `Existing session bound to ${name}; profile is now locked.`, "warning");
		hasHistory = false;
	}

	function ensureOpen(ctx: ExtensionContext): boolean {
		if (session.status !== "locked") return true;
		notify(ctx, "Profile locked; start a new session to make changes.", "warning");
		return false;
	}

	async function create(kind: "group" | "profile", ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			notify(ctx, `Creating a ${kind} requires interactive UI.`, "warning");
			return;
		}
		if (!ensureOpen(ctx)) return;
		try {
			const result = await runCreationFlow({
				ctx,
				kind,
				profiles: profiles.snapshot().config,
				groups: groups.snapshot().config,
				skills: getSkillItems(pi),
			});
			if (!result) return;
			if (result.kind === "group") {
				await groups.create(result.name, result.skills);
				notify(ctx, `Created group @${result.name} with ${result.skills.length} skills.`);
			} else {
				await profiles.create(result.name, { groups: result.groups, skills: result.skills });
				append(selectProfile(session, result.name));
				notify(ctx, `Created and selected profile ${result.name}; locks on first agent run.`);
			}
			refresh();
		} catch (error) {
			notify(ctx, String(error), "warning");
		}
	}

	function doctorText(): string {
		const profileSnapshot = profiles.snapshot();
		const groupSnapshot = groups.snapshot();
		const available = Object.keys(profileSnapshot.config.profiles).sort();
		const installed = getSkillItems(pi);
		const installedGlobals = new Set(
			installed.filter((skill) => skill.scope !== "project").map((skill) => skill.name),
		);
		const groupMembers = Object.entries(groupSnapshot.config.groups).flatMap(([group, definition]) =>
			definition.skills
				.filter((skill) => !installedGlobals.has(skill))
				.map((skill) => `@${group}: uninstalled ${skill}`),
		);
		const members = available.flatMap((profile) => {
			const resolution = resolveProfile(profileSnapshot.config, groupSnapshot.config, profile, installed);
			return [
				...resolution.unknownGroups.map((group) => `${profile}: unknown group @${group}`),
				...resolution.unknownSkills.map((skill) => `${profile}: uninstalled ${skill}`),
			];
		});
		return [
			`Profiles: ${profileSnapshot.readOnly ? "read-only fallback" : profileSnapshot.created ? "created" : profileSnapshot.upgraded ? "upgraded v2 → v3" : "loaded"}`,
			`Groups: ${groupSnapshot.readOnly ? "read-only fallback" : groupSnapshot.missing ? "not created" : "loaded"}`,
			`Session: ${statusText}`,
			`Default: ${profileSnapshot.config.defaultProfile || "fallback"}`,
			`Available: ${available.join(", ") || "none"}`,
			...profileSnapshot.diagnostics,
			...groupSnapshot.diagnostics,
			...diagnostics,
			...candidate().diagnostics,
			...groupMembers,
			...members,
		].join("\n");
	}

	pi.on("session_start", async (_event, ctx) => {
		session = { status: "unbound" };
		diagnostics = [];
		const branch = reconstructProfile(ctx.sessionManager.getBranch());
		session = branch.state;
		hasHistory = branch.hasHistory && session.status === "unbound";
		diagnostics.push(...branch.diagnostics);
		// Resources are discovered after session_start; defer profile bootstrapping
		// until a command or before_agent_start supplies the discovered skills.
		refreshSkillFooterThinkingLevel(ctx);
		installSkillManagerFooter(ctx, () => statusText);
	});

	pi.on("model_select", () => requestSkillFooterRender());
	pi.on("thinking_level_select", (event) => setSkillFooterThinkingLevel(event.level));

	pi.on("before_agent_start", async (event, ctx) => {
		// Resolve using Pi's structured skill collection, not slash commands.
		const items = (event.systemPromptOptions.skills ?? []).map((skill) => ({
			name: skill.name,
			scope: skill.sourceInfo?.scope,
		}));
		await load(items);
		if (session.status !== "locked") lock(ctx, items);
		if (session.status !== "locked") throw new Error("Profile lock failed");
		const filtered = filterSkills(event.systemPromptOptions.skills ?? [], new Set(session.resolvedGlobalSkills));
		event.systemPromptOptions.skills = filtered.skills;
		diagnostics.push(...filtered.diagnostics.filter((message) => !diagnostics.includes(message)));
		refresh();
	});

	pi.registerCommand("skm", {
		description: "Select or create session skill profiles and groups",
		getArgumentCompletions: async (prefix) => {
			await load();
			const names = Object.keys(profiles.snapshot().config.profiles);
			const options = [
				"profile",
				"default",
				"create group",
				"create profile",
				"doctor",
				...names.map((name) => `profile ${name}`),
				...names.map((name) => `default ${name}`),
			];
			return options
				.filter((option) => option.startsWith(prefix))
				.map((option) => ({ value: option, label: option }));
		},
		handler: async (args, ctx) => {
			await load();
			const [action, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			const config = profiles.snapshot();
			const available = Object.keys(config.config.profiles).sort();
			if (!action) {
				const text = `${statusText}; profiles: ${available.join(", ") || "none"}`;
				if (!ctx.hasUI) {
					notify(ctx, text);
					return;
				}
				const options =
					session.status === "locked"
						? [...available, SHOW_DOCTOR]
						: [
								...available,
								CREATE_GROUP,
								CREATE_PROFILE,
								...(available.length ? [SET_DEFAULT] : []),
								SHOW_DOCTOR,
							];
				const selected = await ctx.ui.select(text, options);
				if (!selected) return;
				if (session.status === "locked") {
					if (selected === SHOW_DOCTOR) notify(ctx, doctorText());
					else notify(ctx, "Profile locked; picker is read-only. Start a new session to make changes.", "warning");
					return;
				}
				if (selected === CREATE_GROUP) await create("group", ctx);
				else if (selected === CREATE_PROFILE) await create("profile", ctx);
				else if (selected === SHOW_DOCTOR) notify(ctx, doctorText());
				else if (selected === SET_DEFAULT) {
					const nextDefault = await ctx.ui.select("Default profile for future sessions", available);
					if (nextDefault) {
						await profiles.setDefault(nextDefault);
						refresh();
						notify(ctx, `Default profile set to ${nextDefault} for future unbound sessions.`);
					}
				} else {
					append(selectProfile(session, selected));
					notify(ctx, `Selected ${selected}; locks on first agent run.`);
				}
				return;
			}
			if (action === "doctor" && !name) {
				notify(ctx, doctorText());
				return;
			}
			if (action === "create" && (name === "group" || name === "profile") && !extra.length) {
				await create(name, ctx);
				return;
			}
			if ((action === "profile" || action === "default") && name && !extra.length) {
				if (!config.config.profiles[name]) {
					notify(ctx, `Unknown profile: ${name}. Available: ${available.join(", ") || "none"}`, "warning");
					return;
				}
				if (!ensureOpen(ctx)) return;
				try {
					if (action === "profile") {
						append(selectProfile(session, name));
						notify(ctx, `Selected ${name}; locks on first agent run.`);
					} else {
						await profiles.setDefault(name);
						refresh();
						notify(ctx, `Default profile set to ${name} for future unbound sessions.`);
					}
				} catch (error) {
					notify(ctx, String(error), "warning");
				}
				return;
			}
			notify(ctx, "Usage: /skm [profile <name>|default <name>|create group|create profile|doctor]", "warning");
		},
	});
}
