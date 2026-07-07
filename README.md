# noidilin pi extensions

Local pi extension monorepo for personal workflow helpers. The root `package.json` registers all extensions through its `pi.extensions` list:

- `noid-bar` — compact lualine-style footer/status bar.
- `noid-bar-config` — personal bar layout and extra bar components.
- `noid-skm` — interactive skill manager for trimming model context.
- `noid-ralph` — Matt/Ralph implementation and orchestration workflow.
- `noid-alive` — AWS resource discovery command/tool.

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

### Ralph (`noid-ralph`)

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
