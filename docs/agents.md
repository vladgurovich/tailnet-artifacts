# Agent instructions

Paste the block below into your agent's instructions file (`AGENTS.md` for Codex,
`CLAUDE.md` for Claude Code, or the equivalent). Adjust the `--by` value per agent,
or set `ARTIFACTS_BY` in the agent's environment instead.

---

## Sharing visual work (tailnet-artifacts)

When you build or change anything visual (UI, HTML mockups, charts, diagrams,
rendered docs) or need to show a screenshot, publish it and give me the link:

```sh
artifacts publish <file-or-dir> --name "<short title>" --by <your agent name> --note "<what this shows>"
```

- The command prints JSON. Reply with `links.latest`.
- While iterating on the same thing, publish new versions to the same artifact
  with `--to <id>` (the `id` from the first publish) instead of creating new ones.
  The page I have open updates by itself.
- Directories need an `index.html` (or pass `--entry page.html`). Built apps:
  publish the build output (e.g. `dist/`), not the source tree, and build with
  relative asset paths (`vite build --base ./`). If `publish` prints a
  `warning:` about root-absolute paths, rebuild and publish again.
- Artifacts run sandboxed: `localStorage`, IndexedDB and cookies are unavailable.
- Dotfiles and `node_modules` are skipped automatically. Don't use
  `--include-hidden`.
- On failure the command exits non-zero and prints a JSON error to stderr; read
  its `message` before retrying. For setup problems (network, token, browser), run
  `artifacts doctor` and report what it says.
- Exit code 3 with "publish scope" means the artifact belongs to another token:
  publish a new artifact instead of `--to`.
- Screenshots of a running page: `artifacts screenshot <url> --name "<title>"`
  (add `--mobile` for a 390×844 phone-sized view).
- Artifacts expire 7 days after the last publish. Use `--keep` only when I ask
  to keep something.
- Never publish secrets, credentials, or private customer data.
