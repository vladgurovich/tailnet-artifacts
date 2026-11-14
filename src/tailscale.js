// Detects this machine's tailnet HTTPS address from `tailscale status --json`,
// so ARTIFACTS_PUBLIC_URL is optional when the server runs next to tailscaled.
import { execFile } from 'node:child_process';

export function parseStatus(json) {
  const status = typeof json === 'string' ? JSON.parse(json) : json;
  const dns = status?.Self?.DNSName?.replace(/\.$/, '');
  if (!dns) return null;
  const certDomains = status.CertDomains ?? [];
  return { url: `https://${dns}`, host: dns, httpsEnabled: certDomains.includes(dns) };
}

/** One probe: resolves to { result, missing }. `missing` means the CLI isn't installed. */
function probe(bin, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, ['status', '--json'], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err?.code === 'ENOENT') return resolve({ result: null, missing: true });
      // `tailscale status` exits non-zero while tailscaled is starting or logged out,
      // but may still print JSON; use it if it has the machine's DNS name.
      try {
        resolve({ result: parseStatus(stdout), missing: false });
      } catch {
        resolve({ result: null, missing: false });
      }
    });
  });
}

const defaultBin = () => process.env.ARTIFACTS_TAILSCALE_BIN || 'tailscale';

/** Resolves to { url, host, httpsEnabled } or null if tailscale is unavailable. */
export async function detectTailscaleUrl({ bin = defaultBin(), timeoutMs = 3000 } = {}) {
  return (await probe(bin, timeoutMs)).result;
}

/**
 * Like detectTailscaleUrl, but keeps trying for up to `waitMs` while tailscaled is
 * still starting (common at boot: the server can start before tailscaled is up).
 * Gives up at once if the tailscale CLI isn't installed.
 */
export async function waitForTailscaleUrl({ bin = defaultBin(), waitMs = 60000, intervalMs = 2000, timeoutMs = 3000, onWait } = {}) {
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    const { result, missing } = await probe(bin, timeoutMs);
    if (result || missing || Date.now() >= deadline) return result;
    if (attempt === 0) onWait?.();
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
}
