# Deploying with Node.js and systemd

This guide installs the server by hand on a Linux machine with systemd. Shortcuts:
on **Proxmox**, the [LXC script](platforms.md#proxmox-ve-lxc) does all of this for
you; for **Docker** (including Synology), see [platforms.md](platforms.md).

Run every command as **root** (or prefix with `sudo`). First do the
[Before you start](platforms.md#before-you-start) steps in the Tailscale admin console.

**Sizing:** the server uses about 60 MB of RAM at rest, plus up to
`ARTIFACTS_MAX_PUBLISH_SIZE` (50 MB) per upload in progress, so 512 MB is plenty.
Disk is the real constraint: size it for `ARTIFACTS_MAX_DATA_SIZE` (8 GB) plus headroom.

## 1. Node.js and Tailscale

Install **Node.js 22 or newer** system-wide, so `node` is in `/usr/bin` or
`/usr/local/bin`. Use your distribution's packages or the official builds from
[nodejs.org](https://nodejs.org/en/download); per-user installs such as `nvm`
aren't visible to systemd.

Install Tailscale ([instructions per distribution](https://tailscale.com/download/linux)),
then join your tailnet:

```sh
tailscale up --hostname artifacts        # approve in the browser, or add --auth-key=…
```

In an unprivileged **LXC container**, Tailscale also needs the TUN device: add these
lines to `/etc/pve/lxc/<id>.conf` on the Proxmox host and restart the container.

```
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

## 2. Install the app

```sh
useradd --system --home /var/lib/tailnet-artifacts --create-home --shell /usr/sbin/nologin tailnet-artifacts
git clone --branch v0.5.0 https://github.com/vladgurovich/tailnet-artifacts.git /opt/tailnet-artifacts
cd /opt/tailnet-artifacts && npm ci --omit=dev
cp examples/tailnet-artifacts.env /etc/tailnet-artifacts.env
chgrp tailnet-artifacts /etc/tailnet-artifacts.env && chmod 640 /etc/tailnet-artifacts.env
```

## 3. Configure

Edit `/etc/tailnet-artifacts.env` and set `ARTIFACTS_OWNERS` to your Tailscale login.
Leave `ARTIFACTS_PUBLIC_URL` commented out: the server detects its address from the
`tailscale` CLI. All settings are in [configuration.md](configuration.md).

If you change `ARTIFACTS_DATA_DIR`, also change `ReadWritePaths=` in the systemd unit
to match; the unit only lets the service write there.

## 4. Start and expose

```sh
cp /opt/tailnet-artifacts/examples/systemd/tailnet-artifacts.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now tailnet-artifacts
tailscale serve --bg http://127.0.0.1:8790
systemctl restart tailnet-artifacts      # picks up the address now that serve is on
journalctl -u tailnet-artifacts -n 5     # look for "detected public URL from tailscale"
```

If the log has no `detected public URL` line (for example, the `tailscale` CLI isn't
available to the service), set `ARTIFACTS_PUBLIC_URL=https://artifacts.<tailnet>.ts.net`
in the env file and restart. Without it, requests through `tailscale serve` get 421.

## 5. Create a publish token

```sh
sudo -u tailnet-artifacts ARTIFACTS_DATA_DIR=/var/lib/tailnet-artifacts \
  node /opt/tailnet-artifacts/bin/tailnet-artifacts.js token create my-laptop
```

It prints the token once, plus the `artifacts login` command to run on the
publishing machine. Create one token per machine or agent. Add `--scope admin`
only for a token that must manage every artifact. `token list` shows names and
scopes; `token revoke <name>` removes one.

## 6. Check

```sh
curl -s http://127.0.0.1:8790/healthz
```

Then [set up a publishing machine](../README.md#set-up-a-publishing-machine) and run
`artifacts doctor` there.

## Upgrading

Releases are on the [Releases page](https://github.com/vladgurovich/tailnet-artifacts/releases).

```sh
cd /opt/tailnet-artifacts && git fetch --tags && git checkout vX.Y.Z && npm ci --omit=dev
cp examples/systemd/tailnet-artifacts.service /etc/systemd/system/ && systemctl daemon-reload
systemctl restart tailnet-artifacts && curl -s http://127.0.0.1:8790/healthz
```

## Backups

Copy `ARTIFACTS_DATA_DIR`. It's plain files (`meta.json` per artifact, version
directories, tombstones, the token file). A copy taken while the server runs is
consistent per artifact, because versions are immutable and `meta.json` is replaced
atomically.

## Sharing with people outside your tailnet

Tailscale can share a single machine with another Tailscale user (admin console →
machine → Share). They can reach only that machine and can view all artifacts; only
`ARTIFACTS_OWNERS` can pin, extend or delete.
