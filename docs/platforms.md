# Running on your platform

Every recipe ends the same way: the server is reachable at
`https://<machine>.<tailnet>.ts.net` from your tailnet only, and you have a publish
token. Then [set up a publishing machine](../README.md#set-up-a-publishing-machine).

| Platform | Recipe | Tested on |
| --- | --- | --- |
| Proxmox VE | [LXC container script](#proxmox-ve-lxc) | Proxmox VE 9.1, amd64 (install and `--upgrade`) |
| Synology DSM | [Container Manager](#synology-dsm-container-manager) | DSM 7.4.1 on a DS920+, with `docker compose` over SSH. The Container Manager UI steps are untested. |
| Any Docker host | [Docker Compose](#any-docker-host) | Docker 24 (Synology) and Docker 29 (macOS), amd64. Raspberry Pi (arm64), Unraid and TrueNAS SCALE should work but are untested. |
| Linux with systemd | [docs/deploy.md](deploy.md) | Ubuntu 24.04 LXC |

## Before you start

All of these are in the [Tailscale admin console](https://login.tailscale.com/admin).

1. **Enable HTTPS certificates.** DNS page → HTTPS Certificates → Enable.
   `tailscale serve` can't serve HTTPS without them.
2. **Note your tailnet DNS name.** On the DNS page, e.g. `tail1234.ts.net`. Your
   server will be at `https://<machine>.<tailnet DNS name>`, where `<machine>` is
   the hostname you choose (`artifacts` by default). If that name is taken on your
   tailnet, Tailscale adds a suffix such as `artifacts-1`; check the Machines page.
3. **Find your Tailscale login** for `ARTIFACTS_OWNERS`. It's the identity shown on
   the Users page: usually an email, or `name@github` for GitHub sign-ins. Once the
   server runs, `https://<machine>.<tailnet>/api/whoami` shows it as `viewer.login`.
4. **Docker only: create an auth key.** Settings → Keys → Generate auth key. Leave
   *Reusable* off and *Ephemeral* off (so the machine stays on your tailnet).
   Copy it; it's shown once and only needed for the first start.

---

## Proxmox VE (LXC)

A script you run on the Proxmox host (amd64) creates an unprivileged Debian 12
container, installs Node.js, tailnet-artifacts (as a hardened systemd service) and
Tailscale, runs `tailscale serve`, and prints your first publish token.

```sh
# on the Proxmox host, as root
curl -fsSLO https://raw.githubusercontent.com/vladgurovich/tailnet-artifacts/v0.5.1/deploy/proxmox/create-lxc.sh
less create-lxc.sh                       # read what it does first
bash create-lxc.sh --owners you@example.com
```

It prints a Tailscale login link: open it and approve the machine. To skip that
step, put an auth key in a file and add `--ts-authkey-file /root/ts-key`.

Defaults: next free container ID, hostname `artifacts`, 1 core, 512 MB RAM, 12 GB on
`local-lvm`, bridge `vmbr0`, starts on boot. See `bash create-lxc.sh --help`.

**Upgrading** to a newer release (tags are on the
[Releases page](https://github.com/vladgurovich/tailnet-artifacts/releases)):

```sh
bash create-lxc.sh --upgrade <ctid> --version vX.Y.Z
```

It keeps your data and settings, health-checks the new version, and rolls back to
the previous one if the check fails.

**Next:** [set up a publishing machine](../README.md#set-up-a-publishing-machine) with the printed token.

---

## Synology DSM (Container Manager)

Needs DSM 7.2+ with **Container Manager** (Package Center) on a model that supports
it (most "+" models). No TUN device or extra packages are needed: the Tailscale
sidecar runs in userspace networking mode.

1. **Files.** In File Station, create a folder such as `docker/tailnet-artifacts`.
   Download the three files from
   [`deploy/docker/`](https://github.com/vladgurovich/tailnet-artifacts/tree/v0.5.1/deploy/docker)
   and upload them there, renaming as you go:
   - `compose.yaml` → `docker-compose.yml`
   - `serve.json` (unchanged)
   - `.env.example` → `.env`

   File Station hides names starting with a dot unless **Settings → Show hidden
   files** is on.
2. **Settings.** Edit `.env` (File Station → right-click → Open with Text Editor):
   - `TS_AUTHKEY`: the auth key from [Before you start](#before-you-start)
   - `TS_HOSTNAME`: e.g. `artifacts`
   - `ARTIFACTS_PUBLIC_URL`: `https://artifacts.<tailnet DNS name>`
   - `ARTIFACTS_OWNERS`: your Tailscale login
3. **Project.** Container Manager → Project → Create. Name it `tailnet-artifacts`,
   set the path to the folder from step 1, and choose to use the existing
   `docker-compose.yml`. Finish the wizard; it pulls the images and starts both
   containers.
4. **Token.** Container Manager → Container → `tailnet-artifacts-artifacts-1` →
   Action → Open terminal → Create → `sh`, then run:
   ```sh
   node /app/bin/tailnet-artifacts.js token create my-laptop
   ```
5. **Check** from any device on your tailnet: open
   `https://artifacts.<tailnet DNS name>/`. The first load can take up to a minute
   while Tailscale fetches the certificate.

Over SSH instead of the UI: `cd` to the folder, then `sudo docker compose up -d` and
`sudo docker compose exec artifacts node /app/bin/tailnet-artifacts.js token create my-laptop`.

Your data lives in Docker volumes named `tailnet-artifacts_artifacts-data` and
`tailnet-artifacts_tailscale-state`. Hyper Backup can't select Docker volumes; back
up by exporting the project, or treat artifacts as disposable (they expire anyway).

**Next:** [set up a publishing machine](../README.md#set-up-a-publishing-machine) with the token.

---

## Any Docker host

Linux servers, Raspberry Pi 4/5 (64-bit OS), Unraid and TrueNAS SCALE can all run
the same Compose file. The image is published for `linux/amd64` and `linux/arm64`.

```sh
mkdir tailnet-artifacts && cd tailnet-artifacts
base=https://raw.githubusercontent.com/vladgurovich/tailnet-artifacts/v0.5.1/deploy/docker
curl -fsSLO $base/compose.yaml
curl -fsSLO $base/serve.json
curl -fsSL  $base/.env.example -o .env
$EDITOR .env                  # TS_AUTHKEY, TS_HOSTNAME, ARTIFACTS_PUBLIC_URL, ARTIFACTS_OWNERS
docker compose up -d
docker compose exec artifacts node /app/bin/tailnet-artifacts.js token create my-laptop
```

To upgrade, change `ARTIFACTS_VERSION` in `.env` to the new release (without the
`v`) and run `docker compose up -d`.

**Next:** [set up a publishing machine](../README.md#set-up-a-publishing-machine) with the token.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Site times out right after install | Tailscale is still fetching the HTTPS certificate; wait up to a minute. In Docker, `docker compose logs tailscale` shows `got cert` when it's done. |
| `421 Misdirected Request` | The address you opened doesn't match `ARTIFACTS_PUBLIC_URL`. Check the machine name Tailscale actually assigned (Machines page); it may have a suffix such as `-1`. |
| `tailscale serve` says Serve isn't enabled | Open the link it prints to enable Serve for your tailnet, then run the command again. |
| Gallery shows no Pin/Delete buttons | Your login isn't in `ARTIFACTS_OWNERS` (compare with `/api/whoami`), or you're on a tagged device, which has no user login. |
| Sidecar logs `auth key expired` or `invalid key` | Generate a new key, update `.env`, run `docker compose up -d`. After the first successful start the key isn't needed. |
| `artifacts` can't connect | Run `artifacts doctor` on the publishing machine. |
