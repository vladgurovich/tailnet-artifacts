// Publishing client used by `artifacts publish` / `artifacts screenshot`.
import { readFile, readdir, lstat, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { encodeBundle, BUNDLE_TYPE } from '../wire.js';

const SKIP = new Set(['.git', '.DS_Store', 'Thumbs.db']);

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

/** Collect files from a file or directory. Symlinks and VCS metadata are skipped. */
export async function collectFiles(target) {
  const st = await lstat(target);
  if (st.isSymbolicLink()) throw new Error(`${target} is a symlink; pass the real path`);
  if (st.isFile()) return [{ path: basename(target), data: await readFile(target) }];
  if (!st.isDirectory()) throw new Error(`${target} is not a file or directory`);
  const out = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push({ path: relative(target, full).split(sep).join('/'), data: await readFile(full) });
    }
  }
  await walk(target);
  out.sort((a, b) => a.path.localeCompare(b.path));
  if (!out.length) throw new Error(`${target} contains no files`);
  return out;
}

export async function publish({ url, token, files, options, fetchImpl = fetch }) {
  if (!url) throw new Error('no server URL: set ARTIFACTS_URL or "url" in ~/.config/tailnet-artifacts/config.json');
  if (!token) throw new Error('no publish token: set ARTIFACTS_TOKEN or write it to ~/.config/tailnet-artifacts/token');
  const endpoint = options.to
    ? `${url}/api/artifacts/${encodeURIComponent(options.to)}/versions`
    : `${url}/api/artifacts`;
  const { to: _to, ...wireOptions } = options;
  const body = encodeBundle(files, stripNulls(wireOptions));
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': BUNDLE_TYPE },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: 'bad_response', message: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new Error(json.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/** Take a screenshot with the Playwright CLI (via npx) and return its path. */
export async function screenshot(targetUrl, { mobile = false, viewport = '1280,800', fullPage = true, waitMs = 0, pkg } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'artifacts-shot-'));
  const out = join(dir, 'screenshot.png');
  const args = ['-y', pkg || process.env.ARTIFACTS_PLAYWRIGHT || 'playwright', 'screenshot', '--browser', 'chromium'];
  if (mobile) args.push('--device', 'iPhone 15');
  else args.push('--viewport-size', viewport);
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
