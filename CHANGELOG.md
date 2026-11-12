# Changelog

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
