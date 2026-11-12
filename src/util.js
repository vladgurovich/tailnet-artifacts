import { randomBytes } from 'node:crypto';

const DURATION_UNITS = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };

/** Parse "90s", "15m", "12h", "7d", "2w" (or a bare number of ms) into milliseconds. */
export function parseDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smhdw])\s*$/i.exec(String(v ?? ''));
  if (!m) throw new Error(`invalid duration: ${v} (use e.g. 30m, 12h, 7d, 2w)`);
  return Math.round(Number(m[1]) * DURATION_UNITS[m[2].toLowerCase()]);
}

const SIZE_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

/** Parse "50MB", "8GB", "512kb" (or a bare number of bytes) into bytes. */
export function parseSize(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?\s*$/i.exec(String(v ?? ''));
  if (!m) throw new Error(`invalid size: ${v} (use e.g. 50MB, 8GB)`);
  return Math.round(Number(m[1]) * SIZE_UNITS[(m[2] || 'b').toLowerCase()]);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

/** Lowercase, ASCII, dash-separated, max 40 chars. */
export function slugify(s) {
  const slug = String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'artifact';
}

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
export function randomSuffix(len = 4) {
  const bytes = randomBytes(len);
  let out = '';
  for (const b of bytes) out += B36[b % 36];
  return out;
}

export const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?-[a-z0-9]{4}$/;

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/**
 * Validate a relative file path from an upload or URL. Returns the normalized
 * POSIX path, or null if it is unsafe (absolute, traversal, control chars, empty segments).
 */
export function safeRelPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) return null;
  if (/[\0-\x1f\\]/.test(p)) return null;
  if (p.startsWith('/')) return null;
  const parts = p.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null;
  }
  return parts.join('/');
}

/** Free-form source label (agent/tool/person), trimmed and length-limited. */
export function cleanLabel(s, max = 80) {
  if (s == null) return null;
  const v = String(s).replace(/[\0-\x1f\x7f]/g, '').trim().slice(0, max);
  return v || null;
}
