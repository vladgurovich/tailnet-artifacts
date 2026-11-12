// Identity adapters answer "who is this browser request from?".
// Each adapter: identify(req) -> { login, name, provider } | null
//
// v1 ships "tailscale" and "none". Future adapters (e.g. Cloudflare Access JWT,
// generic OIDC) plug in here without changes elsewhere.

/**
 * `tailscale serve` adds Tailscale-User-Login / Tailscale-User-Name headers for
 * requests from user-owned devices. The server must only be reachable through
 * `tailscale serve` (bind to 127.0.0.1) for these headers to be trustworthy.
 */
export const tailscale = {
  name: 'tailscale',
  identify(req) {
    const login = header(req, 'tailscale-user-login');
    if (!login) return null;
    return {
      login: login.toLowerCase(),
      name: decodeName(header(req, 'tailscale-user-name')) || login,
      provider: 'tailscale',
    };
  },
};

export const none = {
  name: 'none',
  identify() {
    return null;
  },
};

const ADAPTERS = { tailscale, none };

export function getIdentityAdapter(name) {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`unknown identity adapter: ${name}`);
  return a;
}

function header(req, name) {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() || null;
}

// Tailscale encodes non-ASCII names as RFC 2047 "=?utf-8?q?...?=" in some versions.
function decodeName(v) {
  if (!v) return null;
  const m = /^=\?utf-8\?q\?(.*)\?=$/i.exec(v);
  if (!m) return v;
  try {
    return decodeURIComponent(m[1].replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, '%$1'));
  } catch {
    return v;
  }
}
