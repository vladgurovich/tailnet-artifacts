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
  `sandbox` header, so it runs in an opaque origin and cannot touch the gallery
  or other artifacts.

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

IDs are a slug of the name plus a random suffix, e.g. `checkout-redesign-x1vp`.

## Install the server

Requirements: Node.js 22 or newer, and Tailscale on the same machine.

```sh
git clone https://github.com/vladgurovich/tailnet-artifacts.git /opt/tailnet-artifacts
cd /opt/tailnet-artifacts && npm ci --omit=dev

export ARTIFACTS_DATA_DIR=/var/lib/tailnet-artifacts
node bin/tailnet-artifacts.js token create my-laptop   # prints a token once
node bin/tailnet-artifacts.js serve                    # listens on 127.0.0.1:8790

sudo tailscale serve --bg http://127.0.0.1:8790         # https://<machine>.<tailnet>.ts.net
```

For a long-running setup (systemd unit, dedicated user, Proxmox container) see
[docs/deploy.md](docs/deploy.md).

## Publish

On any machine that can reach the server:

```sh
npm install -g github:vladgurovich/tailnet-artifacts   # provides `artifacts`
mkdir -p ~/.config/tailnet-artifacts
echo '{"url": "https://artifacts.<tailnet>.ts.net"}' > ~/.config/tailnet-artifacts/config.json
echo '<token>' > ~/.config/tailnet-artifacts/token && chmod 600 ~/.config/tailnet-artifacts/token
```

```sh
artifacts publish ./mockup.html --name "Login redesign" --by codex
artifacts publish ./dist --to login-redesign-k3f9 --note "tighter spacing"
artifacts publish ./screenshot.png --name "Checkout bug" --ttl 30d
artifacts publish ./notes.md --keep
artifacts screenshot http://localhost:5173 --mobile --name "Home (mobile)"
```

`publish` prints JSON:

```json
{
  "id": "login-redesign-k3f9",
  "name": "Login redesign",
  "version": 2,
  "kind": "html",
  "expiresAt": "2026-11-19T18:00:00.000Z",
  "links": {
    "latest": "https://artifacts.example.ts.net/a/login-redesign-k3f9/",
    "version": "https://artifacts.example.ts.net/a/login-redesign-k3f9/?v=2",
    "raw": "https://artifacts.example.ts.net/a/login-redesign-k3f9/v/2/",
    "info": "https://artifacts.example.ts.net/a/login-redesign-k3f9/info"
  }
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

`screenshot <url>` takes a full-page screenshot with the Playwright CLI (via `npx`)
and publishes it. Add `--mobile` for a 390×844 phone viewport, `--viewport 1440,900`,
`--wait 1000`, or any publish option.

**What can be published:** a single HTML file, a directory (entry `index.html`),
an image (PNG, JPG, GIF, WebP, AVIF, SVG), a PDF, a Markdown file (rendered), or
any other single file (offered as a download). Symlinks and `.git` are skipped.

### Agent instructions

Paste [docs/agents.md](docs/agents.md) into `AGENTS.md`, `CLAUDE.md` or your
agent's equivalent so it publishes UI work and replies with the link.

## Configuration (server)

Environment variables override `--config file.json`, which overrides defaults.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARTIFACTS_DATA_DIR` | `./data` | Where artifacts, tombstones and tokens live |
| `ARTIFACTS_HOST` / `ARTIFACTS_PORT` | `127.0.0.1` / `8790` | Listen address. Keep loopback; see Security |
| `ARTIFACTS_PUBLIC_URL` | from request | Base URL used in returned links, e.g. `https://artifacts.example.ts.net` |
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
- Expiry is checked on every request, so an artifact stops being served the
  moment it expires. Its links return **410 Gone** with its title.
- A sweep on startup and every hour deletes expired artifacts from disk and
  leaves a small tombstone (kept for `ARTIFACTS_TOMBSTONE_TTL`).
- Publishing a new version restarts the clock. Publishing to an expired artifact
  is refused; publish a new one.
- Owners can pin, unpin, extend (+7 days) or delete from the gallery. Token
  holders can do the same through the API.
- When storage reaches `ARTIFACTS_MAX_DATA_SIZE`, new publishes are refused.
  Nothing unexpired is ever deleted to make room.

## Security model

Read this before exposing the server to anyone but yourself.

- **Access is the tailnet.** The server binds to `127.0.0.1` and is reached only
  through `tailscale serve`, which terminates TLS and only accepts tailnet peers.
  Anyone who can reach it can **view** every artifact.
- **Publishing needs a token.** Owner actions in the browser (pin, extend,
  delete) need a Tailscale login listed in `ARTIFACTS_OWNERS`, plus a CSRF
  header that cross-site pages cannot send.
- **Identity headers are only trustworthy behind `tailscale serve`.** If you bind
  to another address, anything that reaches the port can claim to be an owner.
  The server warns at startup in that case.
- **Artifact content is sandboxed.** Raw content is served with
  `Content-Security-Policy: sandbox allow-scripts …` (no `allow-same-origin`),
  and the viewer frames it with the same sandbox. Artifact scripts run in an
  opaque origin: they cannot read the gallery, call owner APIs with your
  identity, read other artifacts' storage, or navigate the top window.
  Exception: PDFs are served unsandboxed because Chromium refuses to render them
  in sandboxed frames; the browser's PDF viewer is isolated on its own.
- **Content responses allow `Origin: null` via CORS** so module scripts and fonts
  load inside the sandbox. A page on another website that creates its own
  sandboxed frame could therefore read an artifact *if* it knows the URL and the
  visitor is on your tailnet. IDs include a random suffix, but treat artifacts as
  shared with your tailnet, not as secrets.
- **Designed for trusted publishers.** The sandbox contains mistakes and
  misbehaving pages from your own agents. It is not a hardened multi-tenant host
  for strangers' uploads; use separate content domains for that (the
  `ARTIFACTS_CONTENT_ORIGIN` setting is the hook for a future version).
- Upload paths are validated (no absolute paths, `..`, backslashes or control
  characters), files are written with exclusive-create into a staging directory
  and renamed into place, and the server never follows symlinks when serving.

## Development

```sh
npm install
npm test          # node:test, no extra tooling
npm start         # serve with ./data
```

The code is small on purpose: `src/store.js` (storage, versions, expiry),
`src/server.js` (HTTP), `src/render.js` (pages), `src/cli/client.js`
(publishing), `src/identity.js` and `src/urls.js` (extension points).

## License

[MIT](LICENSE)
