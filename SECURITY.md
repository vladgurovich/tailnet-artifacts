# Security policy

tailnet-artifacts serves HTML written by AI agents and relies on Tailscale for
access control, so security reports are very welcome.

## Supported versions

Only the latest minor release gets fixes. Before 1.0, that means the newest
`0.x` release; upgrade before reporting if you can.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability
reporting: **Security → Report a vulnerability** on this repository.

Include what you can of: the affected version, your setup (behind
`tailscale serve` or not, identity adapter, `ARTIFACTS_CONTENT_ORIGIN`), steps
to reproduce, and the impact you see. You should get a reply within a week. Fixes
are released as soon as practical and credited in the changelog unless you prefer
otherwise.

## Scope

In scope: anything that lets a published artifact, a tailnet peer, a website
visited from a tailnet device, or a token holder do more than the
[security model](README.md#security-model) describes. For example: escaping the
content sandbox, acting as an owner, reading files outside the data directory,
crashing or exhausting the server, or leaking tokens.

Out of scope, because the security model already says so:

- Anyone on the tailnet (or with the machine shared to them) can view all artifacts.
- Every publish token can manage every artifact.
- Artifacts can fetch other artifacts' URLs if they know them.
- Running the server somewhere other than behind `tailscale serve` on a dedicated host.
