# noidilin pi extensions

Local pi extension monorepo for personal workflow helpers. The root `package.json` registers all extensions through its `pi.extensions` list:

- `noid-bar` — compact lualine-style footer/status bar.
- `noid-bar-config` — personal bar layout and extra bar components.
- `noid-skm` — interactive skill manager for trimming model context.
- `noid-ralph` — Matt/Ralph implementation and orchestration workflow. **Parked — not loaded.**
- `noid-alive` — AWS resource discovery command/tool.
- `noid-remote-figma` — OAuth + MCP config for Figma's hosted Remote MCP server.

## Setup

Install dependencies from this directory:

```bash
cd ~/.config/pi/extensions
npm install
npm test
npm run check
```

Load the package by adding this directory as a pi package/extension source, or by symlinking/copying it into an auto-discovered extension location. After edits, use `/reload` in pi.

## Extensions

### Bar (`noid-bar`)

Replaces pi's built-in footer with a compact status line. It can show session, token/context usage, model, git branch, legacy status modules, timers, and custom components.

Commands:

```text
/bar on
/bar off
/bar status
/bar reload
/bar preset default|minimal|powerline|diagnostic|verbose
```

Preset names can also be invoked directly, for example `/bar minimal`.

### Bar config (`noid-bar-config`)

Personalizes the bar layout for this config repo. It adds:

- `think.level` — current thinking level, or `off` for models without reasoning.
- `skill.groups` — selected skill-manager group set.

Default layout emphasizes session, token/context usage, skill state, model, and thinking level.

### Skill manager (`noid-skm`)

Lets you choose which global skills are visible to the model context. Project-local/protected skills remain available, but global skills can be grouped, enabled, disabled, and searched.

Commands:

```text
/skm          # open the interactive selector
/skm doctor   # print health/config diagnostics
```

Interactive keys:

- `↑/↓` move
- `Tab` switch between groups and skills
- `Space` or `Enter` toggle the selected group/skill
- `/` search
- `r` recategorize a skill into a group
- `Esc` or `q` close

State is stored under the XDG pi config directory, including `skill-manager.json` and skill group configuration.

### Ralph (`noid-ralph`) — parked

> **Disabled, source retained.** `./packages/noid-ralph/index.ts` is off the root `pi.extensions` list, so pi does
> not load it and none of the `/ralph` commands are registered. The package, its tests, and its notes stay in the
> workspace and still typecheck and run under `npm run check` / `npm test`, so it will not rot while parked.
> Re-enable by adding the entrypoint back to `pi.extensions` in the root `package.json` and to the expected list in
> `packages/noid-bar/ship-manifest.test.ts`. Existing `.ralph/` state directories in your projects are untouched.
>
> The rest of this section documents the behavior as it was when last loaded.

Ralph is a disciplined implementation loop inspired by Matt Pocock-style agent workflows, with optional herdr-backed orchestration for GitHub parent issues.

Core idea: keep the agent focused on one target at a time, require validation and a local commit before advancing, persist durable notes/state under `.ralph/`, and never push automatically. Ralph injects active-session instructions into the system prompt and exposes the `matt_ralph_done` tool so the agent can advance only after the current target is implemented, tested, committed, and notes are updated.

Implementation session commands:

```text
/ralph implement #123 [--max-iterations N]
/ralph implement docs/prd/example.md
/ralph status
/ralph resume <session>
/ralph stop
/ralph cancel <session>
/ralph archive <session>
/ralph clean [--all]
```

Implementation workflow:

1. Ralph resolves the issue/PRD target and creates `.ralph` state plus a notes file.
2. The agent reads project guidance, fetches issue details, and works only on the current target.
3. The agent validates changes, creates a local git commit, and updates the `.ralph` notes.
4. The agent calls `matt_ralph_done` to advance to the next target.
5. After final verification, the agent emits `MATT_RALPH_COMPLETE`; Ralph handles final GitHub issue comments/closure where applicable.

Safety behavior:

- Ralph records initial dirty worktree status.
- Ralph guards `git commit` calls so `.ralph` state/notes are unstaged and not accidentally committed.
- Ralph asks/pauses rather than silently pushing, closing, or broadening scope.

#### Ralph orchestration with herdr

Orchestration runs the open child issues of a GitHub parent issue in dependency order inside herdr worker panes. The parent pi session owns planning, pause/stop policy, resume, and parent finalization; each child issue runs as a fresh child Ralph session.

Commands:

```text
/ralph orchestrate plan #123
/ralph orchestrate start #123 [--yes] [--issue-timeout 2h]
/ralph orchestrate status [name]
/ralph orchestrate resume [name]
/ralph orchestrate stop [name]
```

Use orchestration when a parent issue contains multiple child issues and you want Ralph to run them sequentially, verify each child closed/committed, record pane diagnostics on failure, and pause cleanly for human intervention. `start` and `resume` require running inside herdr and require `gh`, `git`, and a clean worktree outside `.ralph/**`.

### AWS alive (`noid-alive`)

Lists deployed/running AWS resources visible to the current AWS CLI authentication. It is available as both a command and an LLM tool (`aws_alive_services`).

Command:

```text
/aws-alive [--profile name] [--region region|--all-regions] [service] [--limit n]
```

Examples:

```text
/aws-alive --profile my-sso --region us-east-1 ec2
/aws-alive --all-regions --limit 100
```

Use when asking pi which AWS services/resources are alive in the authenticated account.

### Remote Figma (`noid-remote-figma`)

Authenticates and configures Figma's hosted Remote MCP server (`https://mcp.figma.com/mcp`) so an existing
[`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) install can expose Figma tools in pi. Ported from
[`DianP/pi-figma-remote-auth`](https://github.com/DianP/pi-figma-remote-auth). It is **not** the local Figma desktop
MCP bridge — remote endpoint only.

Two jobs: write the `mcpServers.figma` entry with `auth: "oauth"`, then run the OAuth 2.1 + PKCE flow and save the
tokens where `pi-mcp-adapter` looks for them.

Prerequisite — install the adapter first, then restart pi:

```bash
pi install npm:pi-mcp-adapter
```

Commands:

```text
/figma help
/figma status [--server figma]
/figma setup  [--global|--project|--shared] [--server name] [--url url] [--direct-tools] [--keep-alive]
/figma login  [--server figma] [--url url] [--client-name Codex] [--port n]
/figma logout [--server figma]
```

Typical first run is `/figma setup` then `/figma login`. `login` prints a copyable authorization URL — the browser is
never opened automatically. After authorizing, restart pi or run `/mcp reconnect figma`, then use the adapter proxy:

```ts
mcp({ connect: "figma" });
mcp({ tool: "figma_TOOL_NAME", args: "{}" });
```

Config targets: `--global` (default) writes `<pi agent dir>/mcp.json`, `--project` writes `.pi/mcp.json`, `--shared`
writes `.mcp.json`. Pass the same `--url` to both `setup` and `login` — the adapter matches stored credentials to the
configured URL string exactly.

Token store: `login` writes `<base>/sha256-<sha256(serverName)>/tokens.json` with mode `0600`, where `<base>` is
`$MCP_OAUTH_DIR` (used verbatim, no `~` expansion) or `<pi agent dir>/mcp-oauth`. Adapter 2.7.0–2.12.x reads that
plaintext file in place; >= 2.13.0 imports it into the OS credential store on the next connect and deletes it, so a
missing file after a successful `login` is expected. `logout` only removes plaintext files — use `/mcp logout figma`
to clear credentials already in the OS store.

Two things worth knowing:

- Dynamic client registration sends `client_name: "Codex"` by default, because Figma allowlists which MCP clients may
  register. Override with `--client-name` if you would rather not present as another vendor's client.
- The OAuth callback server binds `127.0.0.1` only, so the callback is not reachable from the LAN (upstream bound
  every interface), but the advertised redirect URI must spell the host `localhost`. Figma accepts a literal
  `127.0.0.1` redirect URI at dynamic registration *and* at the authorize step, then rejects the token exchange
  with `invalid_grant` — so the bind host and the advertised host are deliberately different constants in
  `oauth.ts`, pinned by `oauth.test.ts`. Do not "fix" them to match.
