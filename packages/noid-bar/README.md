# bar extension

Compact, lualine-style footer for pi.

## Commands

```text
/bar on
/bar off
/bar status
/bar reload
/bar preset default|minimal|powerline|diagnostic|verbose
```

Preset names can also be used directly, for example `/bar minimal`.

## Default layout

Sections follow lualine naming:

```text
bar_a bar_b bar_c                                bar_x bar_y bar_z
pwd branch session  tokens context              legacy.statuses model
```

Built-in components:

- `pwd`
- `branch`
- `session`
- `tokens`
- `context`
- `model`
- `legacy.statuses`
- `session.time`
- `last_response.time`

## Setup

```ts
import { bar } from "noid-bar/api";

bar.setup({
  preset: "default",
  options: {
    sectionSeparators: "  ",
    componentSeparators: " ",
    alwaysDivideMiddle: true,
    sectionStyles: {
      bar_b: "warning",
      bar_z: "dim",
    },
  },
  sections: {
    bar_a: ["pwd", "branch"],
    bar_b: ["tokens", "context"],
    bar_c: [],
    bar_x: ["legacy.statuses"],
    bar_y: [],
    bar_z: ["model"],
  },
});
```

Calling `bar.setup()` again replaces previous setup-provided extension components, so stale components are not kept.

## Presets

```ts
import { bar } from "noid-bar/api";

bar.preset("minimal");
// or
bar.setup({ preset: "diagnostic" });
```

At runtime:

```text
/bar preset minimal
/bar diagnostic
```

Available presets:

- `default`
- `minimal`
- `powerline`
- `diagnostic`
- `verbose`

## Section styling

```ts
bar.setup({
  options: {
    sectionStyles: {
      bar_a: "accent",
      bar_b: "warning",
      bar_z: (text, { theme }) => theme.fg("dim", text),
    },
  },
});
```

## Component options

```ts
bar.setup({
  sections: {
    bar_b: [
      ["tokens", { icon: "󰓅", padding: 1 }],
      {
        component: "context",
        cond: ({ ctx }) => Boolean(ctx.model),
        fmt: (text) => `[${text}]`,
      },
    ],
  },
});
```

Supported options:

- `icon`: prefix icon, added only after the component has visible output or `drawEmpty` is true
- `separator`: string or `{ left, right }`
- `cond`: predicate to hide a component
- `drawEmpty`: render even when value is empty
- `padding`: number or `{ left, right }`
- `fmt`: format component text before empty filtering
- `minWidth`: hide below this terminal width
- `priority`: lower-priority components are hidden first when a section is cramped
- `refreshInterval`: cache/recompute the component on this interval; works with async components

Separator object semantics:

- `left` applies to `bar_a`, `bar_b`, `bar_c`
- `right` applies to `bar_x`, `bar_y`, `bar_z`

## Custom components

```ts
import { bar } from "noid-bar/api";

bar.component("clock", () => new Date().toLocaleTimeString());
bar.component("slow", async () => {
  const value = await fetchSomething();
  return value;
});

bar.setup({
  sections: {
    bar_y: [["clock", { refreshInterval: 1000 }]],
    bar_z: [["slow", { refreshInterval: 10_000 }], "model"],
  },
});
```

Components may throw or reject; bar catches the error, hides the failed component, and shows one warning notification per component.

## Adaptive layouts

```ts
bar.setup({
  sections: {
    bar_a: [
      ["pwd", { priority: 10 }],
      ["branch", { minWidth: 70, priority: 30 }],
      ["session", { minWidth: 100, priority: 20 }],
    ],
  },
});
```

- `minWidth` hides components below a terminal width.
- If a section is still too wide, lower `priority` components are dropped first.

## Timer builtins

```ts
bar.setup({
  sections: {
    bar_x: ["last_response.time"],
    bar_y: ["session.time"],
  },
});
```

The footer requests a refresh every second while installed, so timers and interval components update automatically.

## Extension modules

```ts
export const myBar = {
  name: "my-extension",
  components: {
    status: () => "ready",
  },
};
```

Use it:

```ts
import { bar } from "noid-bar/api";
import { myBar } from "../my-extension";

bar.setup({
  extensions: [myBar],
  sections: {
    bar_c: ["my-extension.status"],
  },
});
```

## Legacy module API

Older status modules still work through `legacy.statuses`:

```ts
import { notifyBarChanged, registerBarModule } from "noid-bar/api";

let status = "ready";
registerBarModule({ key: "example", priority: 20, render: () => status });
notifyBarChanged();
```
