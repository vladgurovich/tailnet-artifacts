# tailnet-artifacts

Self-hosted, versioned artifact links for AI agents. An agent publishes an HTML
mockup, a built site, a screenshot or a Markdown note; you get a link you can
open on any device in your [Tailscale](https://tailscale.com) tailnet. When the
agent publishes a new version, the open page updates by itself.

Think "Claude Artifacts", but for any agent or tool, on your own hardware, with
no domain, certificate or login provider to set up.

- **One small Node.js process.** No database. One dependency (`marked`).
- **Versions.** Every publish is an immutable version. Links to the latest
  version follow new publishes; links to a specific version never change.
- **Live reload.** The viewer switches to a new version as soon as it lands.
- **Expiry.** Artifacts expire 7 days after their last publish by default.
  Pin the ones you want to keep.
- **Works with any agent.** Publishing is a CLI call that prints JSON. A free-form
  `--by` label records which agent or tool published each version.
- **Isolation without extra domains.** Artifact content is served with a CSP
  `sandbox` header, so its scripts run in an opaque origin and cannot act on the
  gallery or with your identity. See [Security model](#security-model) for the limits.

## How it works

```
 agent / CI / you                         phone, laptop (tailnet)
       │  artifacts publish ./mockup.html          ▲
       │  (HTTPS + bearer token)                   │ https://artifacts.<tailnet>.ts.net
       ▼                                           │
 ┌─────────────────── tailscale serve (TLS, tailnet-only) ─────────────────┐
 │                  tailnet-artifacts on 127.0.0.1:8790                    │
 │   gallery · viewer shell · version history · raw content (sandboxed)    │
 │   data/artifacts/<id>/meta.json + v/<n>/…          hourly expiry sweep  │
 └─────────────────────────────────────────────────────────────────────────┘
```

| Link | What it shows |
| --- | --- |
| `/` | Gallery, newest first |
| `/a/<id>/` | Latest version in a viewer with version picker and live reload |
| `/a/<id>/?v=3` | Version 3 in the viewer |
| `/a/<id>/v/3/` | Version 3 raw, without the toolbar (never changes) |
| `/a/<id>/info` | Version history with notes, sources and sizes |

IDs are a slug of the name plus a 10-character random suffix (about 51 bits),
e.g. `checkout-redesign-k3f9x2m8q1`.

## Install the server

Requirements: Node.js 22 or newer, and Tailscale on the same machine.

```sh
git clone --branch v0.2.0 https://github.com/vladgurovich/tailnet-artifacts.git /opt/tailnet-artifacts
cd /opt/tailnet-artifacts && npm ci --omit=dev

export ARTIFACTS_DATA_DIR=/var/lib/tailnet-artifacts
node bin/tailnet-artifacts.js token create my-laptop   # prints a token once
node bin/tailnet-artifacts.js serve                    # listens on 127.0.0.1:8790

sudo tailscale serve --bg http://127.0.0.1:8790         # https://<machine>.<tailnet>.ts.net
```

Set `ARTIFACTS_PUBLIC_URL` to the address `tailscale serve status` prints. Until you
do, the server only answers requests addressed to `localhost`/`127.0.0.1`.

For a long-running setup (systemd unit, dedicated user, Proxmox container) see
[docs/deploy.md](docs/deploy.md).

## Publish

On any machine that can reach the server:

```sh
npm install -g git+https://github.com/vladgurovich/tailnet-artifacts.git#v0.2.0   # provides `artifacts`
mkdir -p ~/.config/tailnet-artifacts
echo '{"url": "https://artifacts.<tailnet>.ts.net"}' > ~/.config/tailnet-artifacts/config.json
echo '<token>' > ~/.config/tailnet-artifacts/token && chmod 600 ~/.config/tailnet-artifacts/token
```

```sh
artifacts publish ./mockup.html --name "Login redesign" --by codex
artifacts publish ./dist --to login-redesign-k3f9x2m8q1 --note "tighter spacing"
artifacts publish ./screenshot.png --name "Checkout bug" --ttl 30d
artifacts publish ./notes.md --keep
artifacts screenshot http://localhost:5173 --mobile --name "Home (mobile)"
```

`publish` prints JSON. `warnings` lists problems that don't stop the publish, such as
root-absolute asset paths in a built app (they're also printed to stderr):

```json
{
  "id": "login-redesign-k3f9x2m8q1",
  "name": "Login redesign",
  "version": 2,
  "kind": "html",
  "expiresAt": "2026-11-19T18:00:00.000Z",
  "links": {
    "latest": "https://artifacts.example.ts.net/a/login-redesign-k3f9x2m8q1/",
    "version": "https://artifacts.example.ts.net/a/login-redesign-k3f9x2m8q1/?v=2",
    "raw": "https://artifacts.example.ts.net/a/login-redesign-k3f9x2m8q1/v/2/",
    "info": "https://artifacts.example.ts.net/a/login-redesign-k3f9x2m8q1/info"
  },
  "warnings": []
}
```

| Option | Meaning |
| --- | --- |
| `--name "Title"` | Title shown in the gallery (new artifacts, or rename on `--to`) |
| `--to <id>` | Publish a new version of an existing artifact |
| `--note "text"` | What changed, shown in the version history |
| `--by <label>` | Free-form source: `codex`, `claude`, `ci/github-actions`, a person… Defaults to `ARTIFACTS_BY` |
| `--ttl 30d` / `--keep` | Expire this long after the last publish / never expire |
| `--entry page.html` | Entry page for a directory without `index.html` |
| `--expected-version N` | Reject the publish if someone else published after version N |
| `--url-only` | Print only the latest link |
| `--include-hidden` | Also publish dotfiles (`.env`, `.npmrc`, …) and `node_modules`, which are skipped by default |

`screenshot <url>` takes a full-page screenshot with the Playwright CLI (via `npx`)
and publishes it. Add `--mobile` for a 390×844 phone viewport, `--viewport 1440,900`,
`--wait 1000`, or any publish option.

**What can be published:** a single HTML file, a directory (entry `index.html`),
an image (PNG, JPG, GIF, WebP, AVIF, SVG), a PDF, a Markdown file (rendered), a
text file such as `.log`, `.json`, `.csv` or source code (shown inline), or any
other single file (offered as a download). Symlinks and VCS directories are always
skipped; dotfiles and `node_modules` unless `--include-hidden`. Size and file-count
limits are checked before anything is read.

**Built apps (Vite, CRA, Next, …)** must use relative asset paths, because an
artifact lives under `/a/<id>/v/<n>/`, not at the site root:
`vite build --base ./`, `"homepage": "."` for CRA, or `output: 'export'` with
`assetPrefix: './'` for Next. `publish` returns a `warnings` entry (also printed to
stderr) when the entry page references root-absolute paths like `/assets/…`.

**Sandbox limits.** Artifacts run in an opaque origin, so `localStorage`,
`sessionStorage`, IndexedDB and cookies throw `SecurityError`. Apps that need them
must catch the error or keep state in memory.

**Errors.** On failure the CLI prints a JSON object to stderr
(`{"error": "...", "message": "..."}`) and exits with: `2` usage, `3` auth,
`4` version conflict, `5` not found or expired, `6` too large or storage full,
`7` network, `1` anything else.

### Agent instructions

Paste [docs/agents.md](docs/agents.md) into `AGENTS.md`, `CLAUDE.md` or your
agent's equivalent so it publishes UI work and replies with the link.

## Configuration (server)

Environment variables override `--config file.json`, which overrides defaults.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARTIFACTS_DATA_DIR` | `./data` | Where artifacts, tombstones and tokens live |
| `ARTIFACTS_HOST` / `ARTIFACTS_PORT` | `127.0.0.1` / `8790` | Listen address. Keep loopback; see Security |
| `ARTIFACTS_PUBLIC_URL` | none | Base URL used in links, e.g. `https://artifacts.example.ts.net`. Its host is the only non-loopback `Host` accepted |
| `ARTIFACTS_ALLOWED_HOSTS` | none | Extra comma-separated `Host` names to accept |
| `ARTIFACTS_OWNERS` | none | Comma-separated Tailscale logins allowed to pin, extend and delete in the browser |
| `ARTIFACTS_DEFAULT_TTL` | `7d` | Expiry after the last publish |
| `ARTIFACTS_MAX_TTL` | `365d` | Longest `--ttl` accepted (use `--keep` beyond that) |
| `ARTIFACTS_TOMBSTONE_TTL` | `30d` | How long an expired link still says "expired" instead of "not found" |
| `ARTIFACTS_MAX_PUBLISH_SIZE` | `50MB` | Largest single publish |
| `ARTIFACTS_MAX_FILES` | `2000` | Most files in one publish |
| `ARTIFACTS_MAX_DATA_SIZE` | `8GB` | Total storage; publishes are refused (HTTP 507) beyond it |
| `ARTIFACTS_GC_INTERVAL` | `1h` | How often expired artifacts are deleted from disk |
| `ARTIFACTS_IDENTITY` | `tailscale` | `tailscale` (trust `Tailscale-User-*` headers) or `none` |
| `ARTIFACTS_TOKENS_FILE` | `<data>/tokens` | Hashed publish tokens |
| `ARTIFACTS_LOG_LEVEL` | `info` | `debug` logs every request |

Tokens: `tailnet-artifacts token create <name>`, `token list`, `token revoke <name>`.
The server stores only SHA-256 hashes and picks up changes without a restart.
Each version records the name of the token that published it.

## Expiry

- Each artifact has an `expiresAt` time: last publish + TTL, or none when pinned.
- Expiry is checked on every request (and browsers revalidate), so an artifact
  stops being served the moment it expires. Its links return **410 Gone** with its title.
- A sweep on startup and every hour deletes expired artifacts from disk and
  leaves a small tombstone (kept for `ARTIFACTS_TOMBSTONE_TTL`).
- Publishing a new version restarts the clock, using the artifact's own TTL
  (a `--ttl 30d` artifact stays on 30 days) and never moving expiry earlier unless
  you pass `--ttl`. Publishing to an expired artifact is refused; publish a new one.
- Owners can pin, unpin, extend (+7 days) or delete from the gallery. Token
  holders can do the same through the API.
- When storage reaches `ARTIFACTS_MAX_DATA_SIZE`, new publishes are refused.
  Nothing unexpired is ever deleted to make room.

## Security model

Read this before exposing the server to anyone but yourself.

- **Access is the tailnet.** The server binds to `127.0.0.1` and is reached through
  `tailscale serve`, which terminates TLS and only accepts tailnet peers. Anyone who
  can reach it can **view** every artifact. The `visibility` field is always
  `private`, which in this version means "everyone on the tailnet and anyone the
  machine is shared with".
- **Run it on a dedicated machine or container.** Requests whose `Host` is not
  loopback or the `ARTIFACTS_PUBLIC_URL` host are refused (421), which blocks DNS
  rebinding. Any process on the same machine can still reach `127.0.0.1:8790` and
  claim an owner identity, so don't run it next to untrusted code.
- **Publishing needs a token, and every token is all-powerful.** A token can
  publish, add versions to any artifact, pin, extend and delete. Create one token
  per machine or agent, so you can see who did what and revoke one at a time.
- **Owner actions in the browser** (pin, extend, delete) need a Tailscale login
  listed in `ARTIFACTS_OWNERS` and a custom CSRF header that cross-site pages and
  sandboxed artifacts cannot send.
- **Artifact scripts are sandboxed, not invisible.** Raw content is served with
  `Content-Security-Policy: sandbox allow-scripts …` (no `allow-same-origin`), and
  the viewer frames it with the same sandbox. Artifact scripts run in an opaque
  origin: they cannot read the gallery, call owner APIs with your identity, use
  your cookies, or navigate the top window. Trusted pages allow only their own
  scripts by per-response nonce, so an uploaded `.js` can never run on them.
  PDFs are the exception: they're served unsandboxed because Chromium refuses to
  render sandboxed PDFs, and the browser's PDF viewer is isolated on its own.
- **Artifacts can read each other, if they know the URL.** Content responses allow
  `Origin: null` via CORS so module scripts and fonts load inside the sandbox. Every
  sandboxed page, including one artifact and a sandboxed frame on another website
  open in a browser on your tailnet, shares that `null` origin. Such a page can
  fetch any artifact URL it can guess. IDs carry ~51 random bits, so guessing is
  impractical, but treat artifacts as shared with your tailnet, not as secrets.
- **Designed for trusted publishers.** The sandbox contains mistakes and
  misbehaving pages from your own agents. It is not a hardened multi-tenant host
  for strangers' uploads; that needs a separate origin per artifact
  (`ARTIFACTS_CONTENT_ORIGIN` is the hook for a future version).
- **Uploads.** Paths are validated (no absolute paths, `..`, backslashes, empty
  segments or control characters), written with exclusive-create into a staging
  directory and renamed into place. The server never creates symlinks and opens
  files with `O_NOFOLLOW`. The CLI skips dotfiles and `node_modules` by default so
  `.env` files aren't published by accident.
- **Expiry and caching.** Content is sent with `Cache-Control: private, no-cache`
  and an ETag, so browsers revalidate on every view and an expired or deleted
  artifact stops being shown immediately.
- **Resource use.** Downloads are streamed with backpressure and closed when the
  client goes away; publish size, file count and total storage are capped, and
  concurrent publishes reserve storage before writing.

## Development

```sh
npm install
npm test          # node:test, no extra tooling
npm start         # serve with ./data
```

The code is small on purpose: `src/store.js` (storage, versions, expiry),
`src/server.js` (HTTP), `src/render.js` (pages), `src/cli/client.js`
(publishing), `src/identity.js` and `src/urls.js` (extension points).
`test/review.test.js` holds regression tests for the v0.2.0 security review.

## License

[MIT](LICENSE)
