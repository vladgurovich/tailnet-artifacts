// Publish tokens. The server stores only SHA-256 hashes, one per line:
//   <name> sha256:<hex> [scope=publish|admin]
// A missing scope means "admin" (tokens created before scopes existed).
// The file is re-read automatically when it changes (no restart needed).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,63}$/;

/**
 * publish: create artifacts; add versions to, pin, extend and delete only the ones it created.
 * admin:   everything, on every artifact.
 */
export const SCOPES = ['publish', 'admin'];
export const DEFAULT_SCOPE = 'publish';
const LEGACY_SCOPE = 'admin';

export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken() {
  return `ta_${randomBytes(32).toString('base64url')}`;
}

export function parseTokens(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [name, hash, ...rest] = t.split(/\s+/);
    if (!NAME_RE.test(name || '') || !/^sha256:[0-9a-f]{64}$/.test(hash || '')) continue;
    const scopeField = rest.find((f) => f.startsWith('scope='));
    const scope = scopeField ? scopeField.slice(6) : LEGACY_SCOPE;
    if (!SCOPES.includes(scope)) continue; // unknown scope: refuse rather than guess
    out.push({ name, hash: hash.slice(7), scope });
  }
  return out;
}

export class TokenStore {
  constructor(file) {
    this.file = file;
    this.mtimeMs = -1;
    this.entries = [];
  }

  #refresh() {
    let st;
    try {
      st = statSync(this.file);
    } catch {
      this.entries = [];
      this.mtimeMs = -1;
      return;
    }
    if (st.mtimeMs === this.mtimeMs) return;
    this.entries = parseTokens(readFileSync(this.file, 'utf8'));
    this.mtimeMs = st.mtimeMs;
  }

  /** Returns { name, scope } if valid, else null. Compares against every entry in constant time. */
  verify(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 256) return null;
    this.#refresh();
    const h = Buffer.from(hashToken(token), 'hex');
    let match = null;
    for (const e of this.entries) {
      if (timingSafeEqual(h, Buffer.from(e.hash, 'hex')) && !match) match = { name: e.name, scope: e.scope };
    }
    return match;
  }

  /** [{ name, scope }] */
  list() {
    this.#refresh();
    return this.entries.map(({ name, scope }) => ({ name, scope }));
  }

  create(name, scope = DEFAULT_SCOPE) {
    if (!NAME_RE.test(name)) throw new Error(`invalid token name: ${name} (letters, digits, . _ @ : -)`);
    if (!SCOPES.includes(scope)) throw new Error(`invalid scope: ${scope} (use ${SCOPES.join(' or ')})`);
    this.#refresh();
    if (this.entries.some((e) => e.name === name)) throw new Error(`token "${name}" already exists; revoke it first`);
    const token = generateToken();
    this.entries.push({ name, hash: hashToken(token), scope });
    this.#write();
    return token;
  }

  revoke(name) {
    this.#refresh();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.name !== name);
    if (this.entries.length === before) return false;
    this.#write();
    return true;
  }

  #write() {
    mkdirSync(dirname(this.file), { recursive: true });
    const body = '# tailnet-artifacts publish tokens: <name> sha256:<hex> scope=<publish|admin>\n'
      + this.entries.map((e) => `${e.name} sha256:${e.hash} scope=${e.scope}`).join('\n') + '\n';
    writeFileSync(this.file, body, { mode: 0o600 });
    chmodSync(this.file, 0o600);
    this.mtimeMs = statSync(this.file).mtimeMs;
  }
}
