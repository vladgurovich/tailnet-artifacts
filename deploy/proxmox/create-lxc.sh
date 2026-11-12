#!/usr/bin/env bash
# Creates a Proxmox LXC container running tailnet-artifacts behind `tailscale serve`,
# or upgrades one this script created. Run as root on an amd64 Proxmox VE host:
#
#   bash create-lxc.sh --owners you@example.com [--ts-authkey-file /root/ts-key]
#   bash create-lxc.sh --upgrade <ctid> [--version vX.Y.Z]
#
# Without --ts-authkey-file, Tailscale prints a login link to approve the machine.
set -euo pipefail

REPO="vladgurovich/tailnet-artifacts"
VERSION="v0.3.1"
CTID=""
HOSTNAME_="artifacts"
STORAGE="local-lvm"
DISK_GB=12
MEMORY_MB=512
CORES=1
BRIDGE="vmbr0"
OWNERS=""
TOKEN_NAME="first-publisher"
TS_AUTHKEY_FILE=""
USE_TAILSCALE=1
UPGRADE_CTID=""
NODE_MAJOR=24

usage() {
  cat <<EOF
Usage: bash create-lxc.sh [options]
       bash create-lxc.sh --upgrade <ctid> [--version TAG]

  --owners LOGINS          Tailscale logins allowed to pin/extend/delete (comma-separated)
  --ts-authkey-file FILE   Tailscale auth key file (otherwise prints a login link)
  --ctid N                 Container ID (default: next free)
  --hostname NAME          Container and tailnet machine name (default: artifacts)
  --storage NAME           Storage for the root disk (default: local-lvm)
  --disk GB                Root disk size (default: 12)
  --memory MB              Memory (default: 512)
  --cores N                CPU cores (default: 1)
  --bridge NAME            Network bridge (default: vmbr0)
  --version TAG            Release to install (default: ${VERSION})
  --token-name NAME        Name of the first publish token (default: first-publisher)
  --no-tailscale           Skip Tailscale (for testing; the server stays loopback-only)
  --upgrade CTID           Upgrade the app in an existing container to --version
                           (keeps data and config; rolls back if the new version fails)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --owners) OWNERS="$2"; shift 2 ;;
    --ts-authkey-file) TS_AUTHKEY_FILE="$2"; shift 2 ;;
    --ctid) CTID="$2"; shift 2 ;;
    --hostname) HOSTNAME_="$2"; shift 2 ;;
    --storage) STORAGE="$2"; shift 2 ;;
    --disk) DISK_GB="$2"; shift 2 ;;
    --memory) MEMORY_MB="$2"; shift 2 ;;
    --cores) CORES="$2"; shift 2 ;;
    --bridge) BRIDGE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --token-name) TOKEN_NAME="$2"; shift 2 ;;
    --no-tailscale) USE_TAILSCALE=0; shift ;;
    --upgrade) UPGRADE_CTID="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v pct >/dev/null || die "run this on a Proxmox VE host (pct not found)"
[ "$(id -u)" = 0 ] || die "run as root"
[ "$(dpkg --print-architecture)" = amd64 ] || die "only amd64 Proxmox hosts are supported (this script installs x64 Node.js builds)"
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--version must look like v1.2.3"
curl -fsIL -o /dev/null "https://github.com/$REPO/releases/tag/$VERSION" \
  || die "release $VERSION not found (see https://github.com/$REPO/releases)"

in_ct() { pct exec "$CTID" -- env PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive npm_config_update_notifier=false bash -c "$1"; }

if [ -n "$UPGRADE_CTID" ]; then
  CTID="$UPGRADE_CTID"
  [ "$(pct status "$CTID" 2>/dev/null)" = "status: running" ] || die "container $CTID is not running"
  in_ct 'test -f /opt/tailnet-artifacts/package.json && test -f /etc/tailnet-artifacts.env' \
    || die "container $CTID does not look like a tailnet-artifacts install from this script"
  FROM="$(in_ct 'cat /opt/tailnet-artifacts/VERSION 2>/dev/null || echo unknown')"
  say "Upgrading container $CTID from $FROM to $VERSION"
  in_ct "set -e
rm -rf /opt/tailnet-artifacts.new && mkdir -p /opt/tailnet-artifacts.new
curl -fsSL https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz | tar -xz -C /opt/tailnet-artifacts.new --strip-components=1
cd /opt/tailnet-artifacts.new && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null
echo $VERSION > VERSION
rm -rf /opt/tailnet-artifacts.prev
mv /opt/tailnet-artifacts /opt/tailnet-artifacts.prev && mv /opt/tailnet-artifacts.new /opt/tailnet-artifacts
cp /opt/tailnet-artifacts/examples/systemd/tailnet-artifacts.service /etc/systemd/system/
systemctl daemon-reload && systemctl restart tailnet-artifacts"
  if in_ct 'for _ in $(seq 1 20); do curl -fs http://127.0.0.1:8790/healthz >/dev/null && exit 0; sleep 1; done; exit 1'; then
    say "Upgraded: $(in_ct 'curl -fs http://127.0.0.1:8790/healthz' | tr -d '\n ')"
    echo "The previous version is kept in /opt/tailnet-artifacts.prev until the next upgrade."
    exit 0
  fi
  say "Health check failed; rolling back to $FROM"
  in_ct 'rm -rf /opt/tailnet-artifacts.failed && mv /opt/tailnet-artifacts /opt/tailnet-artifacts.failed && mv /opt/tailnet-artifacts.prev /opt/tailnet-artifacts && cp /opt/tailnet-artifacts/examples/systemd/tailnet-artifacts.service /etc/systemd/system/ && systemctl daemon-reload && systemctl restart tailnet-artifacts'
  die "upgrade failed; rolled back. Logs: pct exec $CTID -- journalctl -u tailnet-artifacts -n 50"
fi
if [ -n "$TS_AUTHKEY_FILE" ]; then [ -r "$TS_AUTHKEY_FILE" ] || die "cannot read $TS_AUTHKEY_FILE"; fi
[ -n "$CTID" ] || CTID="$(pvesh get /cluster/nextid)"
pct status "$CTID" >/dev/null 2>&1 && die "container $CTID already exists"

say "Finding a Debian 12 template"
pveam update >/dev/null
TEMPLATE="$(pveam available --section system | awk '{print $2}' | grep -E '^debian-12-standard_.*amd64' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || die "no debian-12-standard template available"
if ! pveam list local | grep -q "$TEMPLATE"; then
  say "Downloading $TEMPLATE"
  pveam download local "$TEMPLATE" >/dev/null
fi

say "Creating container $CTID ($HOSTNAME_)"
pct create "$CTID" "local:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAME_" --cores "$CORES" --memory "$MEMORY_MB" --swap 256 \
  --rootfs "$STORAGE:$DISK_GB" --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp,type=veth" \
  --unprivileged 1 --features nesting=1 --onboot 1 \
  --description "tailnet-artifacts $VERSION (https://github.com/$REPO)" >/dev/null
if [ "$USE_TAILSCALE" = 1 ]; then
  cat >> "/etc/pve/lxc/$CTID.conf" <<'EOF'
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
EOF
fi
pct start "$CTID"


say "Waiting for the network"
for _ in $(seq 1 30); do in_ct 'getent hosts deb.debian.org >/dev/null' && break; sleep 2; done
in_ct 'getent hosts deb.debian.org >/dev/null' || die "container has no network/DNS"

say "Installing Node.js $NODE_MAJOR"
in_ct "set -e
apt-get update -qq && apt-get install -y -qq curl ca-certificates xz-utils >/dev/null
v=\$(curl -fsSL https://nodejs.org/dist/index.json | grep -o '\"version\":\"v$NODE_MAJOR\\.[0-9.]*\"' | head -1 | cut -d'\"' -f4)
curl -fsSL https://nodejs.org/dist/\$v/node-\$v-linux-x64.tar.xz | tar -xJ -C /opt
chown -R root:root /opt/node-\$v-linux-x64
ln -sfn /opt/node-\$v-linux-x64 /opt/node
for b in node npm npx; do ln -sf /opt/node/bin/\$b /usr/local/bin/\$b; done
node --version"

say "Installing tailnet-artifacts $VERSION"
in_ct "set -e
id tailnet-artifacts >/dev/null 2>&1 || useradd --system --home /var/lib/tailnet-artifacts --create-home --shell /usr/sbin/nologin tailnet-artifacts
chmod 700 /var/lib/tailnet-artifacts
mkdir -p /opt/tailnet-artifacts
curl -fsSL https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz | tar -xz -C /opt/tailnet-artifacts --strip-components=1
cd /opt/tailnet-artifacts && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null
echo $VERSION > /opt/tailnet-artifacts/VERSION
cat > /etc/tailnet-artifacts.env <<EOF
ARTIFACTS_DATA_DIR=/var/lib/tailnet-artifacts
ARTIFACTS_HOST=127.0.0.1
ARTIFACTS_PORT=8790
ARTIFACTS_OWNERS=$OWNERS
ARTIFACTS_DEFAULT_TTL=7d
ARTIFACTS_MAX_DATA_SIZE=$(( DISK_GB > 4 ? DISK_GB - 4 : 1 ))GB
EOF
chgrp tailnet-artifacts /etc/tailnet-artifacts.env && chmod 640 /etc/tailnet-artifacts.env
cp /opt/tailnet-artifacts/examples/systemd/tailnet-artifacts.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now tailnet-artifacts >/dev/null 2>&1
for _ in \$(seq 1 20); do curl -fs http://127.0.0.1:8790/healthz >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:8790/healthz >/dev/null"

URL=""
if [ "$USE_TAILSCALE" = 1 ]; then
  say "Installing Tailscale"
  in_ct "set -e
. /etc/os-release
curl -fsSL https://pkgs.tailscale.com/stable/debian/\$VERSION_CODENAME.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL https://pkgs.tailscale.com/stable/debian/\$VERSION_CODENAME.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
apt-get update -qq && apt-get install -y -qq tailscale >/dev/null
systemctl enable --now tailscaled >/dev/null 2>&1"
  if [ -n "$TS_AUTHKEY_FILE" ]; then
    pct push "$CTID" "$TS_AUTHKEY_FILE" /root/.ts-authkey --perms 600
    in_ct "tailscale up --hostname=$HOSTNAME_ --auth-key=file:/root/.ts-authkey; rm -f /root/.ts-authkey"
  else
    in_ct "nohup tailscale up --hostname=$HOSTNAME_ >/tmp/ts-up.log 2>&1 &"
    sleep 5
    LINK="$(in_ct "grep -Eo 'https://login.tailscale.com/[^ ]+' /tmp/ts-up.log | head -1" || true)"
    say "Approve this machine on your tailnet: ${LINK:-see 'tailscale status' in CT $CTID}"
    for _ in $(seq 1 150); do in_ct 'tailscale status --json 2>/dev/null | grep -q "\"BackendState\": \"Running\""' && break; sleep 2; done
    in_ct 'tailscale status --json | grep -q "\"BackendState\": \"Running\""' || die "Tailscale did not come up; approve the machine, then run: pct exec $CTID -- tailscale serve --bg http://127.0.0.1:8790"
  fi
  say "Serving on the tailnet"
  in_ct "tailscale serve --bg http://127.0.0.1:8790 >/dev/null && systemctl restart tailnet-artifacts"
  URL="$(in_ct "tailscale status --json | grep -o '\"DNSName\": \"[^\"]*' | head -1 | cut -d'\"' -f4 | sed 's/\\.\$//'")"
  URL="https://$URL"
fi

say "Creating publish token \"$TOKEN_NAME\""
TOKEN="$(in_ct "set -a; . /etc/tailnet-artifacts.env; set +a; cd /var/lib/tailnet-artifacts; setpriv --reuid=tailnet-artifacts --regid=tailnet-artifacts --init-groups node /opt/tailnet-artifacts/bin/tailnet-artifacts.js token create '$TOKEN_NAME' 2>/dev/null")"

cat <<EOF

tailnet-artifacts $VERSION is running in container $CTID.
  Site:    ${URL:-(no Tailscale: http://127.0.0.1:8790 inside the container)}
  Service: pct exec $CTID -- systemctl status tailnet-artifacts
  Config:  /etc/tailnet-artifacts.env (in the container)

Publish token "$TOKEN_NAME" (shown once):
  $TOKEN

On a publishing machine:
  npm install -g git+https://github.com/$REPO.git#$VERSION
  artifacts login ${URL:-<url>}     # paste the token above
EOF
