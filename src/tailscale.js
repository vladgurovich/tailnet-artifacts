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

/** Resolves to { url, host, httpsEnabled } or null if tailscale is unavailable. */
export function detectTailscaleUrl({ bin = process.env.ARTIFACTS_TAILSCALE_BIN || 'tailscale', timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, ['status', '--json'], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(parseStatus(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}
