# Changelog

## Unreleased

**Documentation** (from a review of every doc against the code)
- README is shorter and task-oriented: prerequisites, "Set up the server" (pointing to one recipe per platform), "Set up a publishing machine" (client prerequisites), publish reference, and summaries.
- New `docs/configuration.md` (every setting with its config-file key, tokens and scopes, expiry rules, client settings, the HTTP API) and `docs/security.md` (adds: Funnel warning, tailnet access rules, storage limits for publish tokens, ownership by token name, tagged devices, upload memory use).
- `docs/platforms.md`: where to find your tailnet name and login, honest "tested on" notes, corrected Synology steps and volume names, Proxmox upgrade via the script, a "next step" after every recipe, more troubleshooting.
- `docs/deploy.md`: configure before starting, so the server no longer starts with a placeholder public URL (421 errors); Node.js and data-directory notes.
- `examples/tailnet-artifacts.env` leaves `ARTIFACTS_PUBLIC_URL` commented out (detected automatically); `.env.example` pins the image version.

**Fixes**
- `scripts/release.mjs` only updates install pins (`scripts/pins.mjs`, with tests). It used to replace every mention of the old version, which had rewritten a historical note in the README.
- `deploy/proxmox/create-lxc.sh --upgrade <ctid> --version vX.Y.Z` upgrades in place with a health check and automatic rollback; the script checks that the release exists and that the host is amd64.
- Every CLI command accepts `--help`. The CLI's pre-upload file limit follows `ARTIFACTS_MAX_FILES`.

**Platforms**
- Docker Compose: the Tailscale sidecar runs in userspace networking mode, so it no longer needs `/dev/net/tun` or `NET_ADMIN`. Tested on Synology DSM 7.4.1 (DS920+); it should also run on Unraid, TrueNAS and rootless hosts.
- `deploy/proxmox/create-lxc.sh`: creates a Debian 12 LXC with Node.js, a hardened systemd service, Tailscale and `tailscale serve`, and prints the first publish token. Tested on Proxmox VE 9.1.
- `docs/platforms.md`: recipes for Proxmox, Synology, any Docker host (including Raspberry Pi, Unraid, TrueNAS) and plain systemd, with troubleshooting.

## 0.3.0 — 2026-11-12

**Token scopes** (security)
- Tokens have a scope: `publish` (the new default) can create artifacts but only change, pin, extend or delete the ones it created; `admin` can change any artifact. `token create --scope`, and `token list` shows scopes. Tokens from before 0.3.0 have no scope and keep full `admin` rights; recreate them to narrow them.
- Artifacts record the token that created them (`createdBy` in the API). Older artifacts use their first version's token.
- **API change:** `/api/whoami` returns `token` as `{ name, scope }` instead of a string.

**Easier setup**
- `artifacts login <url>`: paste (or pipe with `--token-stdin`) a token; it is checked against the server and saved with private permissions.
- `artifacts doctor [--json]`: checks config, server reachability, token, client/server version match and the screenshot browser, with the fix for each problem.
- The server detects its public URL from `tailscale status` when `ARTIFACTS_PUBLIC_URL` is unset, and warns if the tailnet has no HTTPS certificates.
- `token create` prints the `artifacts login` command to run on the publishing machine.
- `/healthz` includes the server version.

**Packaging**
- Docker image (`ghcr.io/vladgurovich/tailnet-artifacts`, amd64 and arm64; non-root, health check) and `deploy/docker/compose.yaml` with a Tailscale sidecar running `tailscale serve`.
- Release workflow: on a version tag, re-runs all tests, then publishes the GitHub Release with changelog notes, the container image, and the npm package (when `NPM_TOKEN` is set).
- `scripts/release.mjs` bumps every version reference, dates the changelog, tests, commits and tags.

## 0.2.1 — 2026-11-12

- `artifacts screenshot` runs the Playwright version this package is tested with (`playwright@<devDependency>`) instead of whatever is latest; override with `ARTIFACTS_PLAYWRIGHT`.
- Screenshot failures are JSON errors (`screenshot_failed`) with the underlying cause, an install hint when the browser is missing, and no leftover temp files. `--viewport` is validated.
- Tests: restart and admin-command coverage, a Playwright browser suite for the gallery and viewer, and screenshot tests (`npm run test:browser`).
- Project files for public release: `SECURITY.md`, `CONTRIBUTING.md`, package metadata, README overview image and status note.

## 0.2.0 — 2026-11-12

Fixes from a security and usability review. See `test/review.test.js`.

**Security and stability**
- Fix a server crash when an artifact was deleted or expired mid-download, and a file-descriptor leak on aborted downloads (streams now use `pipeline` and `O_NOFOLLOW`).
- Reject requests whose `Host` is not loopback or the `ARTIFACTS_PUBLIC_URL` host (DNS rebinding). New `ARTIFACTS_ALLOWED_HOSTS`. **Breaking:** set `ARTIFACTS_PUBLIC_URL` when serving through `tailscale serve`.
- Artifact IDs now use a 10-character unbiased random suffix (was 4). Old IDs keep working.
- Trusted pages allow scripts only by per-response nonce (uploaded `.js` can no longer match `script-src 'self'`).
- Viewer pages for Markdown, text, images and files disable scripts; errors under `/a/<id>/v/<n>/` get the same headers as content.
- Content is sent with `Cache-Control: private, no-cache` and an ETag, so expired content is not shown from cache.
- The CLI skips dotfiles and `node_modules` unless `--include-hidden`, and checks size and file count before reading files.
- Concurrent publishes reserve storage and IDs, so they can't overshoot the storage cap or collide.

**Usability**
- `publish` warns (JSON `warnings` and stderr) when a built app references root-absolute assets; docs explain `--base ./`.
- Nested directories serve their `index.html` with the right base (`dir` → `dir/`), and entries in a sub-directory are redirected to.
- A new version keeps the artifact's TTL and never shortens expiry unless `--ttl` is given.
- `--expected-version` must be a positive integer (it was silently ignored).
- Range requests (video seeking) and 304s.
- Text files (`.log`, `.json`, `.csv`, source…) are shown inline instead of downloaded.
- CLI errors are JSON on stderr with distinct exit codes and the real network cause; redirects are refused so the token is never re-sent elsewhere.
- The viewer reloads when a new version changes kind, shows "gone" when an artifact expires instead of retrying forever, and the version picker reloads to apply the right sandbox.
- `/a/<id>/latest/…` keeps the query string. Startup warns when `ARTIFACTS_PUBLIC_URL` or `ARTIFACTS_OWNERS` is unset.

## 0.1.1 — 2026-11-12

- `artifacts screenshot --mobile` now uses a 390×844 Chromium viewport. The iPhone device preset switched to WebKit, which is often not installed.

## 0.1.0 — 2026-11-12

First release.

- Publish HTML files, directories, images, PDFs, Markdown and other files over HTTP with bearer tokens (hashed at rest).
- Immutable versions, optimistic concurrency (`--expected-version`), free-form `--by` source labels.
- Gallery, viewer shell with version picker and live reload (SSE), version history page.
- Expiry: default 7 days after the last publish, `--ttl`/`--keep`, pin/extend/delete, request-time 410s, hourly sweep with tombstones, storage cap.
- Content isolation with the CSP `sandbox` header; trusted pages with strict CSP and no framing.
- Tailscale identity adapter for owner actions, CSRF-protected.
- `artifacts screenshot` publishes a Playwright screenshot of a URL.
- Extension points for public hosting: identity adapters, single URL builder (`contentOrigin`), `visibility` field, multiple named tokens.
