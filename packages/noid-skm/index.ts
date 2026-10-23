import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	installSkillManagerFooter,
	refreshSkillFooterThinkingLevel,
	requestSkillFooterRender,
	setSkillFooterThinkingLevel,
} from "./footer";
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

export default function skillManagerExtension(pi: ExtensionAPI) {
	const store = new ProfilesStore();
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
			? chooseProfile(store.snapshot().config, pi.getFlag("skill-profile"))
			: { name: session.profileName, diagnostics: [] };
	}

	function refresh() {
		const selected = candidate();
		const name = session.status === "unbound" ? selected.name : session.profileName;
		statusText = `skills: ${name} · ${session.status === "locked" ? "locked" : "open"}${store.snapshot().readOnly || diagnostics.length || selected.diagnostics.length || name === "fallback" ? " ⚠" : ""}`;
		requestSkillFooterRender();
	}

	async function load(skills = getSkillItems(pi)) {
		await store.load(skills);
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
		if (name !== "fallback" && !store.snapshot().config.profiles[name])
			diagnostics.push(`Selected profile no longer exists: ${name}; using core skills`);
		const resolution = resolveProfile(store.snapshot().config, name, skills);
		diagnostics.push(...resolution.unknown.map((member) => `Uninstalled profile member: ${member}`));
		append(lockProfile(name, resolution.names));
		if (hasHistory) notify(ctx, `Legacy session bound to ${name}; profile is now locked.`, "warning");
		hasHistory = false;
	}

	pi.on("session_start", async (_event, ctx) => {
		session = { status: "unbound" };
		diagnostics = [];
		const branch = reconstructProfile(ctx.sessionManager.getBranch());
		session = branch.state;
		hasHistory = branch.hasHistory && session.status === "unbound";
		diagnostics.push(...branch.diagnostics);
		// Resources are discovered after session_start; defer migration and legacy locking
		// until before_agent_start, where Pi supplies the authoritative skill collection.
		refreshSkillFooterThinkingLevel(ctx);
		installSkillManagerFooter(ctx, () => statusText);
	});

	pi.on("model_select", () => requestSkillFooterRender());
	pi.on("thinking_level_select", (event) => setSkillFooterThinkingLevel(event.level));

	pi.on("before_agent_start", async (event, ctx) => {
		// Resolve and migrate using Pi's structured skill collection, not slash commands.
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
		description: "Select a session skill profile or inspect configuration",
		getArgumentCompletions: async (prefix) => {
			await load();
			const names = Object.keys(store.snapshot().config.profiles);
			const options = [
				"profile",
				"default",
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
			const config = store.snapshot();
			const available = Object.keys(config.config.profiles).sort();
			if (!action) {
				const text = `${statusText}; profiles: ${available.join(", ") || "none"}`;
				if (ctx.hasUI && session.status !== "locked" && available.length) {
					const selected = await ctx.ui.select(text, available);
					if (selected) {
						append(selectProfile(session, selected));
						notify(ctx, `Selected ${selected}; locks on first agent run.`);
					}
				} else notify(ctx, text);
				return;
			}
			if (action === "doctor" && !name) {
				const members = Object.keys(config.config.profiles).flatMap((profile) =>
					resolveProfile(config.config, profile, getSkillItems(pi)).unknown.map(
						(skill) => `${profile}: uninstalled ${skill}`,
					),
				);
				notify(
					ctx,
					[
						`Profiles: ${config.readOnly ? "read-only fallback" : config.migrated ? "migrated" : "loaded"}`,
						`Session: ${statusText}`,
						`Default: ${config.config.defaultProfile || "fallback"}`,
						`Available: ${available.join(", ") || "none"}`,
						"Legacy groups: read-only, not used",
						...config.diagnostics,
						...diagnostics,
						...candidate().diagnostics,
						...members,
					].join("\n"),
				);
				return;
			}
			if ((action === "profile" || action === "default") && name && !extra.length) {
				if (!config.config.profiles[name]) {
					notify(ctx, `Unknown profile: ${name}. Available: ${available.join(", ") || "none"}`, "warning");
					return;
				}
				try {
					if (action === "profile") {
						append(selectProfile(session, name));
						notify(ctx, `Selected ${name}; locks on first agent run.`);
					} else {
						await store.setDefault(name);
						refresh();
						notify(ctx, `Default profile set to ${name} for future unbound sessions.`);
					}
				} catch (error) {
					notify(ctx, String(error), "warning");
				}
				return;
			}
			notify(ctx, "Usage: /skm [profile <name>|default <name>|doctor]", "warning");
		},
	});
}
