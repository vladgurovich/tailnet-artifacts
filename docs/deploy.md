# Deploying

A small Linux machine or container on your tailnet is enough: the server uses
well under 100 MB of RAM. Disk is the real constraint; size it for
`ARTIFACTS_MAX_DATA_SIZE` plus headroom.

## 1. Machine

Any Linux host with Node.js 22+ works. On **Proxmox**, an unprivileged LXC
container is a good fit (1 core, 512 MB RAM, disk to taste). Tailscale inside an
unprivileged container needs the TUN device; add to `/etc/pve/lxc/<id>.conf` on
the host and restart the container:

```
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

## 2. Tailscale

```sh
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --hostname artifacts        # approve in the browser, or use --auth-key
```

`tailscale serve` needs HTTPS certificates enabled for your tailnet
(admin console → DNS → HTTPS Certificates).

## 3. Install

```sh
useradd --system --home /var/lib/tailnet-artifacts --create-home --shell /usr/sbin/nologin tailnet-artifacts
git clone https://github.com/vladgurovich/tailnet-artifacts.git /opt/tailnet-artifacts
cd /opt/tailnet-artifacts && git checkout v0.2.1 && npm ci --omit=dev
cp examples/tailnet-artifacts.env /etc/tailnet-artifacts.env   # then edit it
cp examples/systemd/tailnet-artifacts.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now tailnet-artifacts
```

## 4. Publish tokens

Create one token per publishing machine (or agent), and copy it there:

```sh
sudo -u tailnet-artifacts env $(grep -v '^#' /etc/tailnet-artifacts.env | xargs) \
  node /opt/tailnet-artifacts/bin/tailnet-artifacts.js token create dev-box
```

## 5. Expose on the tailnet

```sh
tailscale serve --bg http://127.0.0.1:8790
tailscale serve status        # shows https://artifacts.<tailnet>.ts.net
```

Set `ARTIFACTS_PUBLIC_URL` to that address and `systemctl restart tailnet-artifacts`.
This is required: the server only accepts requests addressed to loopback names or
the `ARTIFACTS_PUBLIC_URL` host, and answers anything else with 421.

## 6. Check

```sh
curl -s http://127.0.0.1:8790/healthz
journalctl -u tailnet-artifacts -f
```

From a publishing machine:

```sh
echo '<h1>hello</h1>' > /tmp/hello.html
artifacts publish /tmp/hello.html --name "Hello" --by me --url-only
```

## Upgrading

```sh
cd /opt/tailnet-artifacts && git fetch --tags && git checkout vX.Y.Z && npm ci --omit=dev
systemctl restart tailnet-artifacts
```

Data in `ARTIFACTS_DATA_DIR` is plain files (`meta.json` per artifact, version
directories, tombstones, the token file).

## Backups

Copy `ARTIFACTS_DATA_DIR`. A copy taken while the server runs is consistent per
artifact because versions are immutable and `meta.json` is replaced atomically.

## Sharing with people outside your tailnet

Tailscale can share a single machine with another Tailscale user (admin console →
machine → Share). They can reach only that machine and can view all artifacts;
only `ARTIFACTS_OWNERS` can pin, extend or delete.
