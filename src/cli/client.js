// Publishing client used by `artifacts publish` / `artifacts screenshot`.
import { readFile, readdir, lstat, mkdtemp, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { encodeBundle, BUNDLE_TYPE } from '../wire.js';
import { parseSize } from '../util.js';

// Never uploaded, even with --include-hidden.
const ALWAYS_SKIP = new Set(['.git', '.hg', '.svn', '.DS_Store', 'Thumbs.db']);
const DEFAULT_MAX_BYTES = '50MB';
const DEFAULT_MAX_FILES = 2000;

export class CliError extends Error {
  constructor(code, message, { exitCode = 1, status, body } = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.status = status;
    this.body = body;
  }
}

/** Exit codes: 2 usage, 3 auth, 4 conflict, 5 not found/gone, 6 too large/storage full, 7 network. */
export function exitCodeFor(status) {
  if (status === 401 || status === 403) return 3;
  if (status === 409) return 4;
  if (status === 404 || status === 410) return 5;
  if (status === 413 || status === 507) return 6;
  return 1;
}

export function configDir(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'tailnet-artifacts');
}

export function clientConfig(env = process.env) {
  const dir = configDir(env);
  let file = {};
  try { file = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')); } catch { /* optional */ }
  let token = env.ARTIFACTS_TOKEN || file.token;
  if (!token) {
    try { token = readFileSync(join(dir, 'token'), 'utf8').trim(); } catch { /* optional */ }
  }
  const url = (env.ARTIFACTS_URL || file.url || '').replace(/\/+$/, '');
  return { url, token, by: env.ARTIFACTS_BY || file.by || null };
}

/**
 * Collect files from a file or directory. Symlinks and VCS metadata are always skipped;
 * dotfiles/dot-directories (.env, .npmrc, .cache…) and node_modules are skipped unless
 * includeHidden is set. Size and count limits are checked before any file is read.
 */
export async function collectFiles(target, {
  includeHidden = false,
  maxBytes = parseSize(process.env.ARTIFACTS_MAX_PUBLISH_SIZE || DEFAULT_MAX_BYTES),
  maxFiles = DEFAULT_MAX_FILES,
  onSkip = () => {},
} = {}) {
  const st = await lstat(target).catch(() => null);
  if (!st) throw new CliError('not_found', `${target} does not exist`, { exitCode: 2 });
  if (st.isSymbolicLink()) throw new CliError('symlink', `${target} is a symlink; pass the real path`, { exitCode: 2 });
  if (st.isFile()) {
    if (st.size > maxBytes) throw new CliError('too_large', `${target} is ${st.size} bytes; limit is ${maxBytes}`, { exitCode: 6 });
    return [{ path: basename(target), data: await readFile(target) }];
  }
  if (!st.isDirectory()) throw new CliError('bad_path', `${target} is not a file or directory`, { exitCode: 2 });

  const found = [];
  let total = 0;
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (ALWAYS_SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      const rel = relative(target, full).split(sep).join('/');
      if (!includeHidden && (e.name.startsWith('.') || e.name === 'node_modules')) {
        onSkip(rel + (e.isDirectory() ? '/' : ''));
        continue;
      }
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const { size } = await stat(full);
        total += size;
        found.push({ path: rel, full });
        if (found.length > maxFiles) {
          throw new CliError('too_many_files', `${target} has more than ${maxFiles} files; publish a build output directory instead`, { exitCode: 6 });
        }
        if (total > maxBytes) {
          throw new CliError('too_large', `${target} is larger than the ${maxBytes}-byte limit; publish a build output directory instead`, { exitCode: 6 });
        }
      }
    }
  }
  await walk(target);
  if (!found.length) throw new CliError('empty', `${target} contains no publishable files`, { exitCode: 2 });
  found.sort((a, b) => a.path.localeCompare(b.path));
  return Promise.all(found.map(async (f) => ({ path: f.path, data: await readFile(f.full) })));
}

export async function publish({ url, token, files, options, fetchImpl = fetch }) {
  if (!url) throw new CliError('no_url', 'no server URL: set ARTIFACTS_URL or "url" in ~/.config/tailnet-artifacts/config.json', { exitCode: 2 });
  if (!token) throw new CliError('no_token', 'no publish token: set ARTIFACTS_TOKEN or write it to ~/.config/tailnet-artifacts/token', { exitCode: 2 });
  const endpoint = options.to
    ? `${url}/api/artifacts/${encodeURIComponent(options.to)}/versions`
    : `${url}/api/artifacts`;
  const { to: _to, ...wireOptions } = options;
  const body = encodeBundle(files, stripNulls(wireOptions));
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': BUNDLE_TYPE },
      body,
      // Never re-send the token or the upload to wherever a redirect points.
      redirect: 'error',
    });
  } catch (e) {
    const cause = e.cause ? ` (${[e.cause.code, e.cause.message].filter(Boolean).join(': ')})` : '';
    throw new CliError('network', `could not reach ${url}: ${e.message}${cause}`, { exitCode: 7 });
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    throw new CliError(json?.error || 'http_error', json?.message || `HTTP ${res.status}: ${text.slice(0, 200)}`,
      { exitCode: exitCodeFor(res.status), status: res.status, body: json });
  }
  if (!json?.links?.latest || !json.id) {
    throw new CliError('bad_response', `unexpected response from ${endpoint} (is ARTIFACTS_URL pointing at tailnet-artifacts?)`, { status: res.status });
  }
  return json;
}

/** Take a screenshot with the Playwright CLI (via npx) and return its path. */
export async function screenshot(targetUrl, { mobile = false, viewport = '1280,800', fullPage = true, waitMs = 0, pkg } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'artifacts-shot-'));
  const out = join(dir, 'screenshot.png');
  const args = ['-y', pkg || process.env.ARTIFACTS_PLAYWRIGHT || 'playwright', 'screenshot', '--browser', 'chromium'];
  // Device presets like "iPhone 15" switch to WebKit; stay on Chromium with a phone-sized viewport.
  args.push('--viewport-size', mobile ? '390,844' : viewport);
  if (fullPage) args.push('--full-page');
  if (waitMs) args.push('--wait-for-timeout', String(waitMs));
  args.push(targetUrl, out);
  await new Promise((resolve, reject) => {
    const p = spawn('npx', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`playwright screenshot failed (exit ${code}): ${stderr.trim().slice(-800)}`))));
  });
  return { path: out, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function stripNulls(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== false));
}
