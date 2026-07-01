import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SkillCatalog } from "./catalog";
import { formatDoctorReport } from "./doctor";

export async function handleSkillManagerCommand(input: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	args: string;
	catalog: SkillCatalog;
	showSelector: () => Promise<void>;
}) {
	const { pi, ctx, args, catalog, showSelector } = input;
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const action = parts[0]?.toLowerCase();

	if (!action) return showSelector();

	if (action === "doctor") {
		pi.sendMessage({ customType: "skill-manager-doctor", content: formatDoctorReport(catalog), display: true });
		return;
	}

	ctx.ui.notify("Usage: /skm [doctor]", "warning");
}
