import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi");
export const PROFILES_PATH = join(CONFIG_DIR, "skm-profiles.json");
export const GROUPS_PATH = join(CONFIG_DIR, "skm-groups.json");
export const PROFILE_CUSTOM_TYPE = "skill-manager-profile-state";
