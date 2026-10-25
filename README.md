# noidilin pi extensions

Local Pi extensions: `noid-skm` (session skill profiles and compact footer) and `noid-remote-figma` (Figma hosted Remote MCP).

```bash
cd ~/.config/pi/extensions
pnpm install
pnpm run check
pnpm test
```

Reload Pi with `/reload` after editing.

## Skill manager (`noid-skm`)

The first run locks a session-local snapshot of the global skills in its selected profile plus `coreSkills`. Project skills are always layered on top of the snapshot. A new session uses `--skill-profile <name>` if valid, otherwise the configured default, otherwise core-only fallback. The CLI flag does not override an existing branch binding. To change a locked profile, start a new session.

```text
/skm                   Open the TUI picker; read-only after lock; show status headlessly
/skm profile <name>    Select a profile before the first agent run
/skm default <name>    Set the default for future unbound sessions
/skm create group      Create a named group in interactive UI
/skm create profile    Create a profile from groups and individual global skills
/skm doctor            Inspect config, references, and session diagnostics
```

Profiles live in the XDG Pi config directory at `skm-profiles.json` (schema v3); groups live independently at `skm-groups.json` (schema v1). Existing schema-v2 profile files are upgraded in place by adding empty group-reference lists. The old `skill-manager.json` and `skill-manager-groups.json` files are not read. If no profiles file exists, SKM creates a `global` profile containing every currently discovered global skill, with no core skills.

A group contains global skill names. A profile contains group references plus individual global skill names; resolution unions and deduplicates those members with `coreSkills`. Group and profile names use independent namespaces, while `core` is reserved in both. Project skills are never stored by the creation UI and are always overlaid at runtime. Empty groups and profiles are allowed. Unknown groups and uninstalled members are excluded and reported by `/skm doctor`. A locked session keeps its original `resolvedGlobalSkills` snapshot even if a referenced group or profile later changes; edits affect only future unlocked sessions. Invalid configuration fails closed to core plus project skills.

The compact footer shows session, token and context usage on the left and extension status, profile/lock state, model and thinking level on the right. Right-side content has priority on narrow terminals.

## Remote Figma (`noid-remote-figma`)

Configures Figma's hosted Remote MCP server (`https://mcp.figma.com/mcp`) for an existing `pi-mcp-adapter` installation. Install with `pi install npm:pi-mcp-adapter`, then run `/figma setup` and `/figma login`. After authorization, restart Pi or run `/mcp reconnect figma`.

```text
/figma help
/figma status [--server figma]
/figma setup [--global|--project|--shared] [--server name] [--url url] [--direct-tools] [--keep-alive]
/figma login [--server figma] [--url url] [--client-name Codex] [--port n]
/figma logout [--server figma]
```
