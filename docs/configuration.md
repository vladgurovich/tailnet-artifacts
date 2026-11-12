# Configuration

## Running commands on the server

`artifacts` and `tailnet-artifacts` are the same program. `npm install -g` puts both
on your `PATH`. On a server installed from git, Docker or the Proxmox script, run it
as `node <install dir>/bin/tailnet-artifacts.js <command>`:

| Install | Command prefix |
| --- | --- |
| npm (`npm install -g`) | `tailnet-artifacts` |
| Docker Compose | `docker compose exec artifacts node /app/bin/tailnet-artifacts.js` |
| Proxmox script / systemd | `sudo -u tailnet-artifacts ARTIFACTS_DATA_DIR=/var/lib/tailnet-artifacts node /opt/tailnet-artifacts/bin/tailnet-artifacts.js` |

Every command accepts `--help`.

## Server settings

Environment variables override a JSON config file, which overrides the defaults.
Point to the file with `--config file.json` or `ARTIFACTS_CONFIG=file.json`.

| Variable | Config file key | Default | Meaning |
| --- | --- | --- | --- |
| `ARTIFACTS_DATA_DIR` | `dataDir` | `./data` | Artifacts, tombstones and the token file |
| `ARTIFACTS_HOST` | `host` | `127.0.0.1` | Listen address. Keep loopback; see [security](security.md) |
| `ARTIFACTS_PORT` | `port` | `8790` | Listen port |
| `ARTIFACTS_PUBLIC_URL` | `publicUrl` | detected | Base URL for links, e.g. `https://artifacts.example.ts.net`. Detected from `tailscale status` when unset. Its host is the only non-loopback `Host` accepted |
| `ARTIFACTS_ALLOWED_HOSTS` | `allowedHosts` | none | Extra `Host` names to accept (comma-separated, or an array in the file) |
| `ARTIFACTS_OWNERS` | `owners` | none | Tailscale logins allowed to pin, extend and delete in the browser (see [finding your login](platforms.md#before-you-start)) |
| `ARTIFACTS_DEFAULT_TTL` | `defaultTtl` | `7d` | Expiry after the last publish |
| `ARTIFACTS_MAX_TTL` | `maxTtl` | `365d` | Longest `--ttl` accepted; use `--keep` beyond that |
| `ARTIFACTS_TOMBSTONE_TTL` | `tombstoneTtl` | `30d` | How long an expired link says "expired" instead of "not found" |
| `ARTIFACTS_MAX_PUBLISH_SIZE` | `maxPublishSize` | `50MB` | Largest single publish |
| `ARTIFACTS_MAX_FILES` | `maxFiles` | `2000` | Most files in one publish |
| `ARTIFACTS_MAX_DATA_SIZE` | `maxDataSize` | `8GB` | Total storage; publishes get HTTP 507 beyond it |
| `ARTIFACTS_GC_INTERVAL` | `gcInterval` | `1h` | How often expired artifacts are deleted from disk |
| `ARTIFACTS_IDENTITY` | `identity` | `tailscale` | `tailscale` (trust `Tailscale-User-*` headers from `tailscale serve`) or `none` |
| `ARTIFACTS_TOKENS_FILE` | `tokensFile` | `<data>/tokens` | Hashed publish tokens |
| `ARTIFACTS_CONTENT_ORIGIN` | `contentOrigin` | none | Reserved for a future separate content origin. **Not supported yet; leave unset.** |
| `ARTIFACTS_LOG_LEVEL` | — | `info` | `debug` logs every request |
| `ARTIFACTS_TAILSCALE_BIN` | — | `tailscale` | The CLI used to detect the public URL |

Durations are a number plus `s`, `m`, `h`, `d` or `w` (`90m`, `12h`, `7d`, `2w`).
Sizes are a number plus `KB`, `MB` or `GB`.

Example config file (keys are camelCase; `ARTIFACTS_*` names are ignored in the file):

```json
{
  "dataDir": "/var/lib/tailnet-artifacts",
  "owners": ["you@example.com"],
  "defaultTtl": "14d",
  "maxDataSize": "20GB"
}
```

Each publish is held in memory while it is received, so allow
`ARTIFACTS_MAX_PUBLISH_SIZE` plus about 1 MB of RAM per concurrent upload on top of
the ~60 MB the server uses at rest.

## Tokens

```sh
tailnet-artifacts token create <name> [--scope publish|admin]   # prints the token once
tailnet-artifacts token list                                    # names and scopes
tailnet-artifacts token revoke <name>
```

(Use the command prefix for your install from the table above.) Names may contain
letters, digits and `. _ @ : -`, up to 64 characters. The server stores only SHA-256
hashes and picks up changes without a restart.

| Scope | Can |
| --- | --- |
| `publish` (default) | create artifacts; add versions to, pin, extend and delete **only the ones it created** |
| `admin` | all of that on **any** artifact |

Create one `publish` token per machine or agent. Ownership follows the token
**name**: a revoked token recreated with the same name controls its old artifacts
again. Tokens created before v0.3.0 have no scope and are treated as `admin`;
recreate them to narrow them.

## Expiry

- Each artifact has an `expiresAt` time: last publish + TTL, or none when pinned.
- Expiry is checked on every request (and browsers revalidate), so an artifact
  stops being served the moment it expires. Its links return **410 Gone** with its title.
- A sweep on startup and every `ARTIFACTS_GC_INTERVAL` deletes expired artifacts
  from disk and leaves a small tombstone (kept for `ARTIFACTS_TOMBSTONE_TTL`).
- Publishing a new version restarts the clock with the artifact's own TTL (a
  `--ttl 30d` artifact stays on 30 days) and never moves expiry earlier unless you
  pass `--ttl`. Publishing to an expired artifact is refused; publish a new one.
- **Extend** adds a duration (default 7 days) to the current expiry, capped at
  `ARTIFACTS_MAX_TTL` from now. It does nothing on pinned artifacts.
- When storage reaches `ARTIFACTS_MAX_DATA_SIZE`, new publishes are refused.
  Nothing unexpired is ever deleted to make room.

## Client settings

`artifacts login` writes these for you.

| Variable | `config.json` key | Meaning |
| --- | --- | --- |
| `ARTIFACTS_URL` | `url` | Server address |
| `ARTIFACTS_TOKEN` | — (stored in the `token` file) | Publish token |
| `ARTIFACTS_BY` | `by` | Default `--by` label |
| `ARTIFACTS_MAX_PUBLISH_SIZE` | — | Size checked before uploading (default `50MB`) |
| `ARTIFACTS_MAX_FILES` | — | File count checked before uploading (default `2000`) |
| `ARTIFACTS_PLAYWRIGHT` | — | Playwright package for `screenshot` (default: the tested version) |

Files live in `~/.config/tailnet-artifacts/` (or `$XDG_CONFIG_HOME/tailnet-artifacts/`).
If you raise the server's size or file limits, raise the client's too, or the CLI
refuses before uploading.

## HTTP API

Everything the CLI and gallery do goes through this API. Requests with a token use
`Authorization: Bearer <token>`; reads need no token.

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | — | `{ ok, version, artifacts }` |
| `GET /api/whoami` | — | Your Tailscale identity (`viewer.login`), token and owner status |
| `GET /api/artifacts` | — | All live artifacts, newest first |
| `GET /api/artifacts/<id>` | — | One artifact with all versions |
| `GET /api/artifacts/<id>/events` | — | Server-sent events: `published`, `removed` |
| `POST /api/artifacts` | token | Publish a new artifact (bundle body; use the CLI) |
| `POST /api/artifacts/<id>/versions` | token in scope | Publish a new version |
| `POST /api/artifacts/<id>/pin` `{"pinned": true}` | token in scope | Pin or unpin |
| `POST /api/artifacts/<id>/extend` `{"ttl": "7d"}` | token in scope | Extend expiry |
| `DELETE /api/artifacts/<id>` | token in scope | Delete now |

```sh
curl -X POST -H "Authorization: Bearer $ARTIFACTS_TOKEN" -d '{"pinned":true}' \
  https://artifacts.example.ts.net/api/artifacts/<id>/pin
```

Browser owners can also call the write endpoints, with the header
`X-Artifacts-Csrf: 1`; the gallery does this for you.
