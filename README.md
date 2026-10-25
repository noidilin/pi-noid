# noidilin pi extensions

Local Pi extensions: `noid-remote-figma` (Figma hosted Remote MCP). Skills are not managed here: they live in the asm library and are activated per project (noidilin/skills ADR-0012).

```bash
cd ~/.config/pi/extensions
pnpm install
pnpm run check
pnpm test
```

Reload Pi with `/reload` after editing.

## Remote Figma (`noid-remote-figma`)

Configures Figma's hosted Remote MCP server (`https://mcp.figma.com/mcp`) for an existing `pi-mcp-adapter` installation. Install with `pi install npm:pi-mcp-adapter`, then run `/figma setup` and `/figma login`. After authorization, restart Pi or run `/mcp reconnect figma`.

```text
/figma help
/figma status [--server figma]
/figma setup [--global|--project|--shared] [--server name] [--url url] [--direct-tools] [--keep-alive]
/figma login [--server figma] [--url url] [--client-name Codex] [--port n]
/figma logout [--server figma]
```
