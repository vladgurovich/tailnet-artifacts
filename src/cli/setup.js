// `artifacts login` and `artifacts doctor`: client setup without hand-editing files.
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { configDir, clientConfig, CliError, PLAYWRIGHT_SPEC } from './client.js';
import { skillCheck } from './skill.js';

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const CLIENT_VERSION = PKG.version;

export function normalizeUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new CliError('usage', `not a URL: ${input} (expected e.g. https://artifacts.example.ts.net)`, { exitCode: 2 });
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new CliError('usage', `URL must be http(s): ${input}`, { exitCode: 2 });
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

async function getJson(url, { token, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const cause = e.cause ? ` (${[e.cause.code, e.cause.message].filter(Boolean).join(': ')})` : '';
    throw new CliError('network', `could not reach ${url}: ${e.message}${cause}`, { exitCode: 7 });
  }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}

/** Check a URL + token against the server. Returns { version, token: { name, scope } }. */
export async function checkServer(url, token, opts) {
  const health = await getJson(`${url}/healthz`, opts);
  if (health.status !== 200 || !health.body?.ok) {
    throw new CliError('bad_response', `${url} does not look like a tailnet-artifacts server (healthz returned ${health.status})`, { exitCode: 7 });
  }
  const who = await getJson(`${url}/api/whoami`, { ...opts, token });
  const tok = who.body?.token;
  if (who.status !== 200 || !tok?.name) throw new CliError('unauthorized', 'the server rejected this token', { exitCode: 3 });
  return { version: health.body.version ?? null, token: tok };
}

/** Write ~/.config/tailnet-artifacts/{config.json,token} with private permissions. */
export function saveLogin({ url, token }, env = process.env) {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const cfgFile = join(dir, 'config.json');
  let existing = {};
  try { existing = JSON.parse(readFileSync(cfgFile, 'utf8')); } catch { /* new */ }
  delete existing.token; // tokens live in the token file only
  writeFileSync(cfgFile, `${JSON.stringify({ ...existing, url }, null, 2)}\n`, { mode: 0o600 });
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  return dir;
}

/** Read a token from stdin: piped input (or --token-stdin), or a hidden prompt on a terminal. */
export async function readToken({ stdin = process.stdin, stderr = process.stderr, piped = !stdin.isTTY } = {}) {
  if (piped) {
    let data = '';
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }
  stderr.write('Paste the publish token (input is hidden): ');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (fn) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stderr.write('\n');
      fn();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value.trim()));
        if (ch === '\u0003') return done(() => reject(new CliError('usage', 'cancelled', { exitCode: 2 })));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export async function login(rawUrl, { token, env = process.env, fetchImpl } = {}) {
  const url = normalizeUrl(rawUrl);
  if (!token) throw new CliError('usage', 'no token given', { exitCode: 2 });
  if (!/^ta_[A-Za-z0-9_-]{20,}$/.test(token)) throw new CliError('usage', 'that does not look like a tailnet-artifacts token (they start with "ta_")', { exitCode: 2 });
  const server = await checkServer(url, token, { fetchImpl });
  const dir = saveLogin({ url, token }, env);
  return { ok: true, url, token: server.token, server: { version: server.version }, client: { version: CLIENT_VERSION }, configDir: dir };
}

function browserInstalled(spec) {
  return new Promise((resolve) => {
    execFile('npx', ['-y', spec, 'install', '--dry-run', 'chromium'], { timeout: 120000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, detail: `could not run npx ${spec}: ${err.message.split('\n')[0]}` });
      const dirs = [...stdout.matchAll(/Install location:\s*(\S+)/g)].map((m) => m[1]);
      if (!dirs.length) return resolve({ ok: false, detail: 'could not determine the browser location' });
      const missing = dirs.filter((d) => !existsSync(d));
      resolve(missing.length
        ? { ok: false, detail: `not installed; run: npx -y ${spec} install chromium` }
        : { ok: true, detail: `${spec} chromium installed` });
    });
  });
}

/** Run all checks. Returns { ok, checks: [{ name, status: ok|warn|fail, detail }] }. */
export async function doctor({ env = process.env, browser = true, fetchImpl } = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const cc = clientConfig(env);

  add('client', 'ok', `tailnet-artifacts ${CLIENT_VERSION}`);
  if (cc.url) add('server url', 'ok', cc.url);
  else add('server url', 'fail', 'not set; run: artifacts login <url>');
  if (cc.token) add('token', 'ok', env.ARTIFACTS_TOKEN ? 'from ARTIFACTS_TOKEN' : `from ${join(configDir(env), 'token')}`);
  else add('token', 'fail', 'not set; run: artifacts login <url>');

  if (cc.url) {
    try {
      const health = await getJson(`${cc.url}/healthz`, { fetchImpl });
      if (health.status === 200 && health.body?.ok) {
        const sv = health.body.version;
        add('server reachable', 'ok', `${cc.url} (server ${sv ?? 'unknown version'})`);
        const minor = (v) => v?.split('.').slice(0, 2).join('.');
        if (sv && minor(sv) !== minor(CLIENT_VERSION)) {
          add('versions', 'warn', `client ${CLIENT_VERSION} vs server ${sv}; upgrade whichever is older`);
        } else if (sv) {
          add('versions', 'ok', 'client and server match');
        }
      } else {
        add('server reachable', 'fail', `${cc.url}/healthz returned ${health.status}${health.status === 421 ? ' (server has a different ARTIFACTS_PUBLIC_URL)' : ''}`);
      }
      if (cc.token && health.status === 200) {
        const who = await getJson(`${cc.url}/api/whoami`, { token: cc.token, fetchImpl });
        const tok = who.body?.token;
        if (tok?.name) add('token valid', 'ok', `"${tok.name}" (${tok.scope} scope)`);
        else add('token valid', 'fail', 'the server rejected this token; ask for a new one and run artifacts login');
      }
    } catch (e) {
      add('server reachable', 'fail', `${e.message}${/ts\.net/.test(cc.url) ? ' — is Tailscale running on this machine?' : ''}`);
    }
  }

  const sk = skillCheck(env);
  add('agent skill', sk.status, sk.detail);

  if (browser) {
    const b = await browserInstalled(env.ARTIFACTS_PLAYWRIGHT || PLAYWRIGHT_SPEC);
    add('screenshot browser', b.ok ? 'ok' : 'warn', b.detail);
  }

  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}

export function formatDoctor(result) {
  const mark = { ok: '✓', warn: '!', fail: '✗' };
  const lines = result.checks.map((c) => `${mark[c.status]} ${c.name.padEnd(19)} ${c.detail}`);
  lines.push('', result.ok ? 'All required checks passed.' : 'Some checks failed; see above.');
  return `${lines.join('\n')}\n`;
}
