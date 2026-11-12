# Security policy

tailnet-artifacts serves HTML written by AI agents and relies on Tailscale for
access control, so security reports are very welcome.

## Supported versions

Only the latest minor release gets fixes. Before 1.0, that means the newest
`0.x` release; upgrade before reporting if you can.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability
reporting: **Security → Report a vulnerability** on this repository.

Include what you can of: the affected version, your setup (Docker, Proxmox or
systemd; behind `tailscale serve` or not), steps to reproduce, and the impact you see. You should get a reply within a week. Fixes
are released as soon as practical and credited in the changelog unless you prefer
otherwise.

## Scope

In scope: anything that lets a published artifact, a tailnet peer, a website
visited from a tailnet device, or a token holder do more than the
[security model](docs/security.md) describes. For example: escaping the
content sandbox, acting as an owner, reading files outside the data directory,
crashing or exhausting the server, or leaking tokens.

Out of scope, because the security model already says so:

- Anyone on the tailnet (or with the machine shared to them) can view all artifacts.
- An `admin` token can manage every artifact (that is what the scope is for).
- A `publish` token can fill the storage up to `ARTIFACTS_MAX_DATA_SIZE`.
- Ownership follows the token name, so a token recreated with the same name controls its old artifacts.
- Exposing the server with Tailscale Funnel or any public proxy.
- Artifacts can fetch other artifacts' URLs if they know them.
- Running the server somewhere other than behind `tailscale serve` on a dedicated host.
