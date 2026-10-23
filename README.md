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
/skm                   Status; choose profile before lock in interactive mode
/skm profile <name>    Select profile before the first agent run
/skm default <name>    Set the default for future unbound sessions
/skm doctor            Inspect migration, config and session diagnostics
```

Configuration lives in the XDG Pi config directory (`skill-manager-profiles.json`). On first use, the extension imports the enabled installed global skills from `skill-manager.json` into one `legacy-imported` profile, without changing the old file or `skill-manager-groups.json` (legacy, read-only). Edit profile definitions in the JSON file and `/reload`; do not edit session entries. Invalid configuration falls back to core plus project skills and is reported by `/skm doctor`. A locked session keeps its original global skill names even after profile definitions change; newly installed skills do not join it automatically.

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
