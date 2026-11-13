# Agent setup

Agents learn to publish from an [Agent Skill](https://agentskills.io):
[`skills/tailnet-artifacts/SKILL.md`](../skills/tailnet-artifacts/SKILL.md). It ships
with the CLI, so it always matches the `artifacts` version you have installed.

## Install the skill

On each publishing machine, after `artifacts login`:

```sh
artifacts skill install
```

This writes the skill to both user-level skill directories:

| Target | Directory | Read by |
| --- | --- | --- |
| `claude` | `~/.claude/skills/` (or `$CLAUDE_CONFIG_DIR/skills/`) | Claude Code; GitHub Copilot and OpenCode also read it |
| `agents` | `~/.agents/skills/` | The shared Agent Skills location: Codex, Gemini CLI, GitHub Copilot, Cursor, OpenCode and other clients |

- One target only: `--target claude` or `--target agents`.
- An agent with its own directory: `--dir <its skills directory>` (repeatable), e.g.
  `--dir ~/.config/goose/skills`.
- No CLI on the machine where the agent runs: copy the file from `artifacts skill print`,
  or point a skills installer at this repository; the skill is at the standard path
  `skills/tailnet-artifacts/`.
- `artifacts skill status` shows where it's installed and whether it's current;
  `artifacts doctor` warns when it's missing or out of date.
- After upgrading the CLI, run `artifacts skill install` again.
- `artifacts skill uninstall` removes it.

Restart running agent sessions to pick up a new skill.

## Add one line to your agent's instructions

Agents load a skill when a task matches its description. To make publishing a habit
rather than something the agent remembers only sometimes, add this line to the
always-on instructions file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
`~/.gemini/GEMINI.md`, or your agent's equivalent):

```md
When you build or change anything visual, publish it with the tailnet-artifacts skill and reply with the link.
```

To record which agent published each version without relying on the agent to pass
`--by`, set `ARTIFACTS_BY` (e.g. `ARTIFACTS_BY=codex`) in that agent's environment.

## Sandboxed agents

The CLI talks to the server over HTTP, so it works inside agent sandboxes that allow
network access. In Codex's `workspace-write` sandbox, enable network access
(`[sandbox_workspace_write] network_access = true` in `~/.codex/config.toml`).
`artifacts doctor` run inside the agent shows whether it can reach the server.

## Agents without skill support

Paste the body of [`SKILL.md`](../skills/tailnet-artifacts/SKILL.md) (everything
after the frontmatter) into the agent's instructions file instead.
