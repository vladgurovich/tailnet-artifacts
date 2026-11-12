# Changelog

## Unreleased

- `artifacts screenshot` runs the Playwright version this package is tested with (`playwright@<devDependency>`) instead of whatever is latest; override with `ARTIFACTS_PLAYWRIGHT`.
- Screenshot failures are JSON errors (`screenshot_failed`) with the underlying cause, an install hint when the browser is missing, and no leftover temp files. `--viewport` is validated.
- Tests: restart and admin-command coverage, a Playwright browser suite for the gallery and viewer, and screenshot tests (`npm run test:browser`).

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
