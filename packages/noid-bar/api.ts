import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

export type BarSectionName = "bar_a" | "bar_b" | "bar_c" | "bar_x" | "bar_y" | "bar_z";
export type BuiltinBarComponent =
	| "pwd"
	| "branch"
	| "session"
	| "tokens"
	| "context"
	| "model"
	| "legacy.statuses"
	| "session.time"
	| "last_response.time";
export type BarComponentName = BuiltinBarComponent | string;

export interface BarRenderContext {
	ctx: ExtensionContext;
	theme: Theme;
	footerData: {
		getGitBranch(): string | null | undefined;
		getExtensionStatuses(): ReadonlyMap<string, string>;
		getAvailableProviderCount(): number;
	};
	section: BarSectionName;
	width: number;
	requestRender(): void;
}

export type BarComponentResult = string | undefined | Promise<string | undefined>;
export type BarComponentFn = (context: BarRenderContext) => BarComponentResult;

export interface BarComponentOptions {
	icon?: string;
	separator?: string | { left?: string; right?: string };
	cond?: (context: BarRenderContext) => boolean;
	drawEmpty?: boolean;
	padding?: number | { left?: number; right?: number };
	fmt?: (text: string, context: BarRenderContext) => string;
	/** Hide this component below this terminal width. */
	minWidth?: number;
	/** Lower priority components are hidden first when the bar is cramped. Default: 50. */
	priority?: number;
	/** Re-render/recompute this component at most once per interval. Supports async components. */
	refreshInterval?: number;
}

export type BarRegisteredComponent =
	| BarComponentFn
	| ({ component: BarComponentName | BarComponentFn } & BarComponentOptions);

export type BarComponentSpec =
	| BarComponentName
	| BarComponentFn
	| [BarComponentName | BarComponentFn, BarComponentOptions?]
	| ({ component: BarComponentName | BarComponentFn } & BarComponentOptions);

export interface BarExtensionModule {
	name: string;
	components: Record<string, BarRegisteredComponent>;
}

export type BarSectionStyle =
	| string
	| ((text: string, context: Omit<BarRenderContext, "section"> & { section: BarSectionName }) => string);
export type BarPresetName = "default" | "minimal" | "powerline" | "diagnostic" | "verbose";

export interface BarOptions {
	sectionSeparators?: string | { left?: string; right?: string };
	componentSeparators?: string | { left?: string; right?: string };
	alwaysDivideMiddle?: boolean;
	sectionStyles?: Partial<Record<BarSectionName, BarSectionStyle>>;
}

export interface BarConfig {
	preset?: BarPresetName;
	options?: BarOptions;
	sections?: Partial<Record<BarSectionName, BarComponentSpec[]>>;
	extensions?: BarExtensionModule[];
}

interface BarRegistry {
	components: Map<string, BarRegisteredComponent>;
	listeners: Set<() => void>;
	setupExtensionKeys: Set<string>;
	config: Required<Pick<BarConfig, "sections">> & { options: Required<BarOptions> };
}

const REGISTRY_KEY = Symbol.for("pi.extensions.bar.registry");

const DEFAULT_CONFIG: BarRegistry["config"] = {
	options: {
		sectionSeparators: "  ",
		componentSeparators: " ",
		alwaysDivideMiddle: true,
		sectionStyles: {},
	},
	sections: {
		bar_a: ["pwd", "branch", "session"],
		bar_b: ["tokens", "context"],
		bar_c: [],
		bar_x: ["legacy.statuses"],
		bar_y: [],
		bar_z: ["model"],
	},
};

function normalizeConfig(config?: {
	options?: BarOptions;
	sections?: Partial<Record<BarSectionName, BarComponentSpec[]>>;
}): BarRegistry["config"] {
	const options = config?.options ?? {};
	return {
		options: {
			sectionSeparators: options.sectionSeparators ?? DEFAULT_CONFIG.options.sectionSeparators,
			componentSeparators: options.componentSeparators ?? DEFAULT_CONFIG.options.componentSeparators,
			alwaysDivideMiddle: options.alwaysDivideMiddle ?? DEFAULT_CONFIG.options.alwaysDivideMiddle,
			sectionStyles: options.sectionStyles ?? DEFAULT_CONFIG.options.sectionStyles,
		},
		sections: { ...DEFAULT_CONFIG.sections, ...(config?.sections ?? {}) },
	};
}

function getRegistry(): BarRegistry {
	const root = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Partial<BarRegistry> };
	root[REGISTRY_KEY] ??= {};
	const registry = root[REGISTRY_KEY]!;
	registry.components ??= new Map();
	registry.listeners ??= new Set();
	registry.setupExtensionKeys ??= new Set();
	registry.config = normalizeConfig(registry.config);
	return registry as BarRegistry;
}

const PRESETS: Record<BarPresetName, Required<Pick<BarConfig, "sections">> & { options: Partial<BarOptions> }> = {
	default: { options: {}, sections: DEFAULT_CONFIG.sections },
	minimal: {
		options: { alwaysDivideMiddle: true },
		sections: {
			...DEFAULT_CONFIG.sections,
			bar_a: ["pwd"],
			bar_b: [],
			bar_c: [],
			bar_x: [],
			bar_y: [],
			bar_z: ["model"],
		},
	},
	powerline: {
		options: { sectionSeparators: { left: "  ", right: "  " }, componentSeparators: { left: "  ", right: "  " } },
		sections: DEFAULT_CONFIG.sections,
	},
	diagnostic: {
		options: {},
		sections: {
			...DEFAULT_CONFIG.sections,
			bar_a: ["pwd", "branch"],
			bar_b: ["context", "tokens"],
			bar_c: ["legacy.statuses"],
			bar_x: ["last_response.time"],
			bar_y: ["session.time"],
			bar_z: ["model"],
		},
	},
	verbose: {
		options: {},
		sections: {
			...DEFAULT_CONFIG.sections,
			bar_a: ["pwd", "branch", "session"],
			bar_b: ["tokens", "context"],
			bar_c: ["legacy.statuses"],
			bar_x: ["last_response.time"],
			bar_y: ["session.time"],
			bar_z: ["model"],
		},
	},
};

function extensionComponentEntries(extension: BarExtensionModule): [string, BarRegisteredComponent][] {
	return Object.entries(extension.components).map(([key, component]) => [`${extension.name}.${key}`, component]);
}

export function setupBar(config: BarConfig = {}): void {
	const registry = getRegistry();
	for (const key of registry.setupExtensionKeys) registry.components.delete(key);
	registry.setupExtensionKeys.clear();
	for (const extension of config.extensions ?? []) {
		for (const [key, component] of extensionComponentEntries(extension)) {
			registry.components.set(key, component);
			registry.setupExtensionKeys.add(key);
		}
	}
	const preset = config.preset ? PRESETS[config.preset] : undefined;
	const current = normalizeConfig(registry.config);
	registry.config = normalizeConfig({
		options: { ...current.options, ...(preset?.options ?? {}), ...(config.options ?? {}) },
		sections:
			preset || config.sections
				? { ...(preset?.sections ?? current.sections), ...(config.sections ?? {}) }
				: current.sections,
	});
	notifyBarChanged();
}

export function registerBarExtension(extension: BarExtensionModule): () => void {
	const registry = getRegistry();
	const entries = extensionComponentEntries(extension);
	for (const [key, component] of entries) registry.components.set(key, component);
	notifyBarChanged();
	return () => {
		let changed = false;
		for (const [key, component] of entries) {
			if (registry.components.get(key) !== component) continue;
			registry.components.delete(key);
			changed = true;
		}
		if (changed) notifyBarChanged();
	};
}

export function registerBarComponent(name: string, component: BarRegisteredComponent): () => void {
	const registry = getRegistry();
	registry.components.set(name, component);
	notifyBarChanged();
	return () => {
		if (registry.components.get(name) !== component) return;
		registry.components.delete(name);
		notifyBarChanged();
	};
}

export function getBarComponent(name: string) {
	return getRegistry().components.get(name);
}

export function getBarConfig() {
	return getRegistry().config;
}

export function notifyBarChanged() {
	for (const listener of getRegistry().listeners) listener();
}

export function subscribeBarChanges(listener: () => void): () => void {
	const registry = getRegistry();
	registry.listeners.add(listener);
	return () => registry.listeners.delete(listener);
}

// Lualine-like facade.
export function setBarPreset(preset: BarPresetName): void {
	setupBar({ preset });
}

export const bar = {
	setup: setupBar,
	preset: setBarPreset,
	component: registerBarComponent,
	extension: registerBarExtension,
	refresh: notifyBarChanged,
};

// Compatibility shim for the previous draft API.
export interface BarModule {
	key: string;
	priority?: number;
	render(ctx: ExtensionContext): string | undefined;
}
const legacyModules = new Map<string, BarModule>();
export function registerBarModule(module: BarModule): () => void {
	legacyModules.set(module.key, module);
	notifyBarChanged();
	return () => {
		if (legacyModules.get(module.key) !== module) return;
		legacyModules.delete(module.key);
		notifyBarChanged();
	};
}
export function getBarModules(): BarModule[] {
	return Array.from(legacyModules.values()).sort(
		(a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.key.localeCompare(b.key),
	);
}
export const registerStatusBarModule = registerBarModule;
export const getStatusBarModules = getBarModules;
export const notifyStatusBarChanged = notifyBarChanged;
export const subscribeStatusBarChanges = subscribeBarChanges;
