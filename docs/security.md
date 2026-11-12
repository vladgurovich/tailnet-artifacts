# Security model

tailnet-artifacts is built for **one person or a small team and their own agents**.
Read this before exposing it to anyone else. To report a vulnerability, see
[SECURITY.md](../SECURITY.md).

## Who can do what

- **Access is the tailnet.** The server binds to `127.0.0.1` and is reached through
  `tailscale serve`, which terminates TLS and only accepts tailnet peers. Anyone who
  can reach the machine can **view** every artifact. The `visibility` field is
  always `private`, which in this version means "everyone on the tailnet and anyone
  the machine is shared with". To narrow that, restrict the machine with tailnet
  access rules (grants or ACLs), for example only your user or a group on port 443.
- **Never enable Tailscale Funnel on this machine.** Funnel makes `tailscale serve`
  reachable from the public internet: every artifact would be public and the
  identity headers would be absent.
- **Publishing needs a token; tokens are scoped.** A `publish` token (the default)
  can only change or delete artifacts it created, so a leaked agent token cannot
  rewrite or wipe other publishers' work. `admin` tokens can change everything.
  Ownership follows the token *name*: recreating a revoked token under the same name
  restores control of its artifacts.
- **A publish token can still fill the storage.** It can create new artifacts until
  `ARTIFACTS_MAX_DATA_SIZE`, after which every publisher gets HTTP 507. Revoke the
  token and delete its artifacts if that happens.
- **Owner actions in the browser** (pin, extend, delete) need a Tailscale login
  listed in `ARTIFACTS_OWNERS` and a custom CSRF header that cross-site pages and
  sandboxed artifacts cannot send. Tagged devices have no user login, so owner
  controls never appear on them.

## Isolation

- **Run it on a dedicated machine or container.** Requests whose `Host` is not
  loopback or the public URL's host are refused (421), which blocks DNS rebinding.
  Any process on the same machine can still reach `127.0.0.1:8790` and claim an
  owner identity, so don't run it next to untrusted code.
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
  misbehaving pages from your own agents. It is not a hardened multi-tenant host for
  strangers' uploads; that needs a separate origin per artifact, which isn't
  supported yet (`ARTIFACTS_CONTENT_ORIGIN` is reserved for it; leave it unset).

## Data handling

- **Uploads.** Paths are validated (no absolute paths, `..`, backslashes, empty
  segments or control characters), written with exclusive-create into a staging
  directory and renamed into place. The server never creates symlinks and opens
  files with `O_NOFOLLOW`. The CLI skips dotfiles and `node_modules` by default so
  `.env` files aren't published by accident.
- **Tokens** are stored as SHA-256 hashes (mode 600) and compared in constant time.
  The client keeps its token in a file readable only by you.
- **Expiry and caching.** Content is sent with `Cache-Control: private, no-cache`
  and an ETag, so browsers revalidate on every view and an expired or deleted
  artifact stops being shown immediately.
- **Resource use.** Downloads are streamed with backpressure and closed when the
  client goes away. Each upload is held in memory while it is received (up to
  `ARTIFACTS_MAX_PUBLISH_SIZE` + 1 MB); publish size, file count and total storage
  are capped, and concurrent publishes reserve storage before writing.
