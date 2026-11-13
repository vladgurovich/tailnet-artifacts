---
name: tailnet-artifacts
description: Publish visual work (HTML pages, UI mockups, built web apps, charts, diagrams, rendered Markdown, images, screenshots of a running page) to the user's tailnet-artifacts server and reply with a link they can open on their phone. Use whenever you build or change something visual, need to show a screenshot, or the user asks to see, share, preview or open something on their phone or another device.
license: MIT
compatibility: Needs the `artifacts` CLI (tailnet-artifacts) on PATH, already logged in to a server, and network access to that server over Tailscale.
---

# Sharing visual work with tailnet-artifacts

When you build or change anything visual, publish it and give the user the link.
They view it on their phone or laptop; you can't show them pixels in a terminal.

```sh
artifacts publish <file-or-dir> --name "<short title>" --by <your agent name> --note "<what this shows>"
```

- `--by` is your own name in lowercase (`claude`, `codex`, `gemini`, …). Skip it if
  `ARTIFACTS_BY` is set in your environment.
- The command prints JSON. Reply with `links.latest`.
- While iterating on the same thing, publish new versions to the same artifact with
  `--to <id>` (the `id` from the first publish) instead of creating new ones. The
  page the user has open updates by itself.
- What to publish: a single file (`.html`, `.md`, image, PDF), or a directory with an
  `index.html` (or a single `.html` file, or name one with `--entry page.html`).
- Built apps: publish the build output (e.g. `dist/`), not the source tree, and build
  with relative asset paths (`vite build --base ./`). If `publish` prints a
  `warning:` about root-absolute paths, rebuild and publish again.
- Artifacts run sandboxed: `localStorage`, IndexedDB and cookies are unavailable.
- Dotfiles and `node_modules` are skipped automatically. Don't use `--include-hidden`.
- Screenshots of a running page (dev server, deployed site):
  `artifacts screenshot <url> --name "<title>"`. Add `--mobile` for a 390×844
  phone-sized view.
- Artifacts expire 7 days after the last publish. Use `--keep` only when the user
  asks to keep something.
- Never publish secrets, credentials, or private customer data.

## When it fails

The command exits non-zero and prints a JSON error to stderr. Read its `message`
before retrying.

| Exit code | Meaning | What to do |
| --- | --- | --- |
| 2 | Bad arguments or path, or the CLI isn't logged in | Fix the command (`artifacts publish --help` lists options). For "no server URL" or "no publish token", tell the user to run `artifacts login`. |
| 3 | Token rejected, or "publish scope" | With "publish scope", the artifact belongs to another token: publish a new artifact instead of `--to`. Otherwise tell the user. |
| 5 | Artifact not found or expired | Publish a new artifact instead of `--to`. |
| 6 | Too large, or server storage full | Publish less (build output only, smaller images). |
| 7 | Network | In a sandbox, network access may be off. Otherwise run `artifacts doctor`. |

If `artifacts` isn't installed, or `artifacts doctor` reports a failed check, tell
the user what it says instead of working around it. Setup is theirs to do.
