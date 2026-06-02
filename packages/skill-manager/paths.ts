import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi");
export const STATE_PATH = join(CONFIG_DIR, "skill-manager.json");
export const GROUPS_PATH = join(CONFIG_DIR, "skill-manager-groups.json");
export const STATE_CUSTOM_TYPE = "skill-manager-config";
