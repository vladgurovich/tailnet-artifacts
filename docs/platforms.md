# Running on your platform

Every recipe ends the same way: the server is reachable at
`https://<machine>.<tailnet>.ts.net` from your tailnet only, and you have a publish
token to use with `artifacts login`.

Before you start, enable **HTTPS certificates** for your tailnet (Tailscale admin
console → DNS → HTTPS Certificates). For the Docker recipes, also create an
**auth key** (admin console → Settings → Keys → Generate auth key; not reusable,
not ephemeral, so the machine stays on your tailnet).

| Platform | Recipe | Tested on |
| --- | --- | --- |
| Proxmox VE | [LXC container script](#proxmox-ve-lxc) | Proxmox VE 9.1 |
| Synology DSM | [Container Manager](#synology-dsm-container-manager) | DSM 7.4.1 on a DS920+ (via SSH `docker compose`) |
| Any Docker host (Linux server, Raspberry Pi 4/5, Unraid, TrueNAS SCALE) | [Docker Compose](#any-docker-host) | Docker 24 and 29, amd64 |
| Linux with systemd | [docs/deploy.md](deploy.md) | Ubuntu 24.04 LXC |

---

## Proxmox VE (LXC)

A script you run on the Proxmox host creates an unprivileged Debian 12 container,
installs Node.js, tailnet-artifacts (as a hardened systemd service) and Tailscale,
runs `tailscale serve`, and prints your first publish token.

```sh
# on the Proxmox host, as root
curl -fsSLO https://raw.githubusercontent.com/vladgurovich/tailnet-artifacts/main/deploy/proxmox/create-lxc.sh
less create-lxc.sh                       # read what it does first
bash create-lxc.sh --owners you@example.com
```

It prints a Tailscale login link: open it and approve the machine. To skip that
step, put an auth key in a file and pass `--ts-authkey-file /root/ts-key`.

Defaults: next free container ID, hostname `artifacts`, 1 core, 512 MB RAM, 12 GB
on `local-lvm`, bridge `vmbr0`, starts on boot. See `bash create-lxc.sh --help`.

Upgrading later:

```sh
pct exec <ctid> -- bash -c 'cd /opt/tailnet-artifacts && \
  curl -fsSL https://github.com/vladgurovich/tailnet-artifacts/archive/refs/tags/vX.Y.Z.tar.gz | tar -xz --strip-components=1 && \
  npm ci --omit=dev && systemctl restart tailnet-artifacts'
```

---

## Synology DSM (Container Manager)

Needs DSM 7.2+ with **Container Manager** (Package Center) on a model that supports
it (most "+" models). No SSH, TUN device or extra packages required: the Tailscale
sidecar runs in userspace networking mode.

1. **Files.** In File Station, create a folder such as `docker/tailnet-artifacts`
   and upload three files from [`deploy/docker/`](../deploy/docker/):
   `compose.yaml`, `serve.json`, and `.env.example` renamed to `.env`.
   (Or create `.env` with a text editor; File Station hides dotfiles unless
   "Show hidden files" is on.)
2. **Settings.** Edit `.env`:
   - `TS_AUTHKEY` — your auth key
   - `TS_HOSTNAME` — e.g. `artifacts`
   - `ARTIFACTS_PUBLIC_URL` — `https://artifacts.<your-tailnet>.ts.net`
   - `ARTIFACTS_OWNERS` — your Tailscale login, e.g. `you@example.com`
3. **Project.** Container Manager → Project → Create. Name it
   `tailnet-artifacts`, set the path to the folder from step 1, choose
   **Use existing docker-compose.yml**, then Next → Done. It pulls the images and
   starts both containers.
4. **Token.** Container Manager → Container → `tailnet-artifacts-artifacts-1` →
   Action → Open terminal → Create → `sh`, then run:
   ```sh
   node /app/bin/tailnet-artifacts.js token create my-laptop
   ```
5. **Check** from any device on your tailnet: open
   `https://artifacts.<your-tailnet>.ts.net/`. The first load can take a few seconds
   while Tailscale fetches the certificate.

From SSH instead of the UI: `cd` to the folder and run `sudo docker compose up -d`
and `sudo docker compose exec artifacts node /app/bin/tailnet-artifacts.js token create my-laptop`.

Data lives in the project's Docker volumes (`artifacts-data`, `tailscale-state`).
Include them in Hyper Backup if you want artifacts to survive a NAS rebuild.

---

## Any Docker host

Linux servers, Raspberry Pi 4/5 (64-bit OS), Unraid and TrueNAS SCALE all run the
same Compose file. The image is published for `linux/amd64` and `linux/arm64`.

```sh
mkdir tailnet-artifacts && cd tailnet-artifacts
base=https://raw.githubusercontent.com/vladgurovich/tailnet-artifacts/main/deploy/docker
curl -fsSLO $base/compose.yaml
curl -fsSLO $base/serve.json
curl -fsSL  $base/.env.example -o .env
$EDITOR .env
docker compose up -d
docker compose exec artifacts node /app/bin/tailnet-artifacts.js token create my-laptop
```

Pin `ARTIFACTS_VERSION` in `.env` to a release (e.g. `0.3.0`) for reproducible
upgrades; change it and run `docker compose up -d` to upgrade.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Site times out right after install | Tailscale is still fetching the HTTPS certificate; wait ~30 s. Check `docker compose logs tailscale` for `got cert`. |
| `421 Misdirected Request` | `ARTIFACTS_PUBLIC_URL` doesn't match the address you opened. |
| Gallery shows no Pin/Delete buttons | Your Tailscale login isn't in `ARTIFACTS_OWNERS`. |
| `artifacts` can't connect | Run `artifacts doctor` on the publishing machine. |
| Sidecar logs `auth key expired` | Generate a new auth key, update `.env`, `docker compose up -d`. Once the machine has joined, the key is no longer needed. |
