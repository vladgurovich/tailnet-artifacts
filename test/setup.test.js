// Token scopes, public URL detection, `artifacts login` and `artifacts doctor`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { writeFile, readFile, stat, chmod, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startServer, tempDir, OWNER, file } from './helpers.js';
import { publish } from '../src/cli/client.js';
import { login, doctor, formatDoctor, normalizeUrl, CLIENT_VERSION } from '../src/cli/setup.js';
import { parseStatus } from '../src/tailscale.js';
import { withPublicUrl, normalize, DEFAULTS } from '../src/config.js';
import { hashToken, generateToken } from '../src/tokens.js';

const BIN = fileURLToPath(new URL('../bin/tailnet-artifacts.js', import.meta.url));

let s;
let other; // a second publish-scoped token
let admin; // an admin token
before(async () => {
  s = await startServer();
  other = s.app.tokens.create('other-box');
  admin = s.app.tokens.create('ops', 'admin');
});
after(async () => { await s.stop(); });

const pubAs = (token, files, options = {}) => publish({ url: s.base, token, files, options });
const call = (method, path, token, body) => fetch(`${s.base}${path}`, {
  method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

// ---- token scopes ----------------------------------------------------------------

test('publish tokens can only change artifacts they created', async () => {
  const mine = await pubAs(s.token, [file('a.html', '1')], { name: 'Mine' });
  const api = await (await fetch(`${s.base}/api/artifacts/${mine.id}`)).json();
  assert.deepEqual(api.createdBy, { token: 'test-publisher' });

  await assert.rejects(pubAs(other, [file('a.html', '2')], { to: mine.id }), (e) => e.status === 403 && /publish scope/.test(e.message));
  assert.equal((await call('POST', `/api/artifacts/${mine.id}/pin`, other, { pinned: true })).status, 403);
  assert.equal((await call('POST', `/api/artifacts/${mine.id}/extend`, other, { ttl: '1d' })).status, 403);
  assert.equal((await call('DELETE', `/api/artifacts/${mine.id}`, other)).status, 403);
  assert.equal((await fetch(`${s.base}/api/artifacts/${mine.id}`)).status, 200, 'untouched');

  // The creator can do all of it.
  const v2 = await pubAs(s.token, [file('a.html', '2')], { to: mine.id });
  assert.equal(v2.version, 2);
  assert.equal((await call('POST', `/api/artifacts/${mine.id}/pin`, s.token, { pinned: true })).status, 200);
  assert.equal((await call('DELETE', `/api/artifacts/${mine.id}`, s.token)).status, 200);
});

test('admin tokens and browser owners can change any artifact', async () => {
  const a = await pubAs(other, [file('a.html', '1')], { name: 'Someone elses' });
  const v2 = await pubAs(admin, [file('a.html', '2')], { to: a.id });
  assert.equal(v2.version, 2);
  assert.equal((await call('POST', `/api/artifacts/${a.id}/extend`, admin, { ttl: '1d' })).status, 200);
  const owner = await fetch(`${s.base}/api/artifacts/${a.id}/pin`, { method: 'POST', body: '{"pinned":true}', headers: { ...OWNER, 'X-Artifacts-Csrf': '1' } });
  assert.equal(owner.status, 200);
  assert.equal((await call('DELETE', `/api/artifacts/${a.id}`, admin)).status, 200);
});

test('tokens written before scopes existed are treated as admin', async () => {
  const legacy = generateToken();
  await appendFile(s.cfg.tokensFile, `legacy sha256:${hashToken(legacy)}\n`);
  const a = await pubAs(other, [file('a.html', '1')], { name: 'For legacy' });
  const who = await (await fetch(`${s.base}/api/whoami`, { headers: { Authorization: `Bearer ${legacy}` } })).json();
  assert.deepEqual(who.token, { name: 'legacy', scope: 'admin' });
  assert.equal((await pubAs(legacy, [file('a.html', '2')], { to: a.id })).version, 2);
});

test('artifacts from before createdBy existed use the first version\'s token', async () => {
  const a = await pubAs(s.token, [file('a.html', '1')], { name: 'Old meta' });
  const meta = s.app.store.metas.get(a.id);
  delete meta.createdBy; // as written by v0.2
  assert.equal((await pubAs(s.token, [file('a.html', '2')], { to: a.id })).version, 2);
  await assert.rejects(pubAs(other, [file('a.html', '3')], { to: a.id }), { status: 403 });
});

// ---- public URL detection --------------------------------------------------------

test('tailscale status parsing and config merge', () => {
  const st = { Self: { DNSName: 'artifacts.example.ts.net.' }, CertDomains: ['artifacts.example.ts.net'] };
  assert.deepEqual(parseStatus(st), { url: 'https://artifacts.example.ts.net', host: 'artifacts.example.ts.net', httpsEnabled: true });
  assert.equal(parseStatus({ Self: { DNSName: 'x.ts.net.' } }).httpsEnabled, false);
  assert.equal(parseStatus({}), null);

  const cfg = normalize({ ...DEFAULTS, dataDir: '/tmp/x' });
  const merged = withPublicUrl(cfg, 'https://artifacts.example.ts.net');
  assert.equal(merged.publicUrl, 'https://artifacts.example.ts.net');
  assert.ok(merged.allowedHosts.has('artifacts.example.ts.net'));
  const explicit = normalize({ ...DEFAULTS, dataDir: '/tmp/x', publicUrl: 'https://set.example' });
  assert.equal(withPublicUrl(explicit, 'https://other.example').publicUrl, 'https://set.example', 'explicit config wins');
});

test('serve detects its public URL from the tailscale CLI', async () => {
  const tmp = await tempDir();
  const fake = join(tmp.dir, 'tailscale');
  await writeFile(fake, `#!/bin/sh\necho '{"Self":{"DNSName":"art.example.ts.net."},"CertDomains":["art.example.ts.net"]}'\n`);
  await chmod(fake, 0o755);
  const child = spawn(process.execPath, [BIN, 'serve'], {
    env: { PATH: process.env.PATH, ARTIFACTS_DATA_DIR: join(tmp.dir, 'data'), ARTIFACTS_PORT: '0', ARTIFACTS_TAILSCALE_BIN: fake },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const logs = [];
    const listening = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(logs.join('\n'))), 10000);
      createInterface({ input: child.stdout }).on('line', (l) => {
        const j = JSON.parse(l);
        logs.push(j);
        if (j.message === 'listening') { clearTimeout(t); resolve(j); }
      });
    });
    assert.equal(listening.publicUrl, 'https://art.example.ts.net');
    assert.ok(logs.some((j) => j.message === 'detected public URL from tailscale'));
    const res = await fetch(`http://${listening.address}/`, { headers: { Host: 'art.example.ts.net' } });
    assert.equal(res.status, 200, 'detected host is accepted');
  } finally {
    child.kill('SIGKILL');
    await tmp.cleanup();
  }
});

// ---- login and doctor --------------------------------------------------------------

test('healthz reports the server version', async () => {
  assert.equal((await (await fetch(`${s.base}/healthz`)).json()).version, CLIENT_VERSION);
});

test('login validates the token and writes private config files', async () => {
  const tmp = await tempDir();
  try {
    const env = { XDG_CONFIG_HOME: tmp.dir };
    const dir = join(tmp.dir, 'tailnet-artifacts');
    await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }));
    await writeFile(join(dir, 'config.json'), JSON.stringify({ by: 'codex', token: 'old-inline-token' }));

    const r = await login(`${s.base}/`, { token: s.token, env });
    assert.equal(r.url, s.base, 'trailing slash removed');
    assert.deepEqual(r.token, { name: 'test-publisher', scope: 'publish' });
    assert.equal(r.server.version, CLIENT_VERSION);
    const cfg = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(cfg, { by: 'codex', url: s.base }, 'keeps other settings, drops inline token');
    assert.equal((await readFile(join(dir, 'token'), 'utf8')).trim(), s.token);
    assert.equal((await stat(join(dir, 'token'))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);

    await assert.rejects(login(s.base, { token: 'ta_' + 'x'.repeat(43), env }), (e) => e.exitCode === 3);
    await assert.rejects(login(s.base, { token: 'not-a-token', env }), (e) => e.exitCode === 2);
    await assert.rejects(login('artifacts.example', { token: s.token, env }), (e) => e.exitCode === 2);
    await assert.rejects(login('http://127.0.0.1:49151', { token: s.token, env }), (e) => e.exitCode === 7);
  } finally {
    await tmp.cleanup();
  }
});

test('login --token-stdin from the CLI, then publish with the saved config', async () => {
  const tmp = await tempDir();
  try {
    const env = { PATH: process.env.PATH, XDG_CONFIG_HOME: tmp.dir, ARTIFACTS_TAILSCALE_BIN: '/nonexistent' };
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [BIN, 'login', s.base, '--token-stdin'], { env });
      let stdout = ''; let stderr = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (code) => resolve({ code, stdout, stderr }));
      p.stdin.end(`${s.token}\n`);
    });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stderr, /Logged in to .* as token "test-publisher" \(publish scope\)/);
    const f = join(tmp.dir, 'page.html');
    await writeFile(f, '<h1>via saved config</h1>');
    const published = await new Promise((resolve) => {
      execFile(process.execPath, [BIN, 'publish', f, '--name', 'Saved config', '--url-only'], { env }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
    });
    assert.equal(published.code, 0, published.stderr);
    assert.match(published.stdout, /\/a\/saved-config-/);
  } finally {
    await tmp.cleanup();
  }
});

test('doctor reports each check and fails on required problems', async () => {
  const good = await doctor({ env: { ARTIFACTS_URL: s.base, ARTIFACTS_TOKEN: s.token }, browser: false });
  assert.equal(good.ok, true, JSON.stringify(good.checks));
  const byName = Object.fromEntries(good.checks.map((c) => [c.name, c]));
  assert.equal(byName['token valid'].detail, '"test-publisher" (publish scope)');
  assert.equal(byName.versions.status, 'ok');
  assert.match(formatDoctor(good), /✓ server reachable/);

  const none = await doctor({ env: { XDG_CONFIG_HOME: '/nonexistent' }, browser: false });
  assert.equal(none.ok, false);
  assert.match(none.checks.find((c) => c.name === 'server url').detail, /artifacts login/);

  const badToken = await doctor({ env: { ARTIFACTS_URL: s.base, ARTIFACTS_TOKEN: 'ta_' + 'y'.repeat(43) }, browser: false });
  assert.equal(badToken.checks.find((c) => c.name === 'token valid').status, 'fail');

  const down = await doctor({ env: { ARTIFACTS_URL: 'http://127.0.0.1:49151', ARTIFACTS_TOKEN: s.token }, browser: false });
  assert.match(down.checks.find((c) => c.name === 'server reachable').detail, /ECONNREFUSED/);

  const fakeHealth = async (url) => new Response(JSON.stringify(url.endsWith('/healthz') ? { ok: true, version: '9.9.0' } : { token: { name: 'x', scope: 'admin' } }));
  const skew = await doctor({ env: { ARTIFACTS_URL: 'http://x', ARTIFACTS_TOKEN: 'ta_z' }, browser: false, fetchImpl: fakeHealth });
  assert.equal(skew.checks.find((c) => c.name === 'versions').status, 'warn');
});

test('doctor CLI: --json output and exit codes', async () => {
  const run = (env) => new Promise((resolve) => {
    execFile(process.execPath, [BIN, 'doctor', '--json', '--skip-browser'], { env: { PATH: process.env.PATH, XDG_CONFIG_HOME: '/nonexistent', ...env } },
      (err, stdout) => resolve({ code: err?.code ?? 0, json: JSON.parse(stdout) }));
  });
  const ok = await run({ ARTIFACTS_URL: s.base, ARTIFACTS_TOKEN: s.token });
  assert.equal(ok.code, 0);
  assert.equal(ok.json.ok, true);
  const bad = await run({});
  assert.equal(bad.code, 1);
  assert.equal(bad.json.ok, false);
  assert.equal(normalizeUrl('https://a.example.ts.net/'), 'https://a.example.ts.net');
});

// ---- waiting for tailscale at startup ----------------------------------------------

test('waitForTailscaleUrl waits while tailscaled is still starting', async () => {
  const { waitForTailscaleUrl } = await import('../src/tailscale.js');
  const d = await tempDir();
  try {
    const counter = join(d.dir, 'n');
    const bin = join(d.dir, 'tailscale');
    // Fails twice (like tailscaled at boot), then reports the machine's name.
    await writeFile(bin, `#!/bin/sh
n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"
if [ $n -lt 3 ]; then echo '{"BackendState":"NoState","Self":{"DNSName":""}}'; exit 1; fi
echo '{"Self":{"DNSName":"artifacts.example.ts.net."},"CertDomains":["artifacts.example.ts.net"]}'
`);
    await chmod(bin, 0o755);
    let waited = 0;
    const r = await waitForTailscaleUrl({ bin, waitMs: 5000, intervalMs: 50, onWait: () => { waited++; } });
    assert.equal(r?.url, 'https://artifacts.example.ts.net');
    assert.equal(waited, 1, 'onWait called once');
    assert.equal((await readFile(counter, 'utf8')).trim(), '3');

    // Never comes up: gives up after waitMs.
    await writeFile(counter, '-100');
    const t0 = Date.now();
    assert.equal(await waitForTailscaleUrl({ bin, waitMs: 300, intervalMs: 50 }), null);
    assert.ok(Date.now() - t0 >= 250);

    // CLI not installed: no waiting at all.
    const t1 = Date.now();
    assert.equal(await waitForTailscaleUrl({ bin: join(d.dir, 'missing'), waitMs: 5000 }), null);
    assert.ok(Date.now() - t1 < 1000);
  } finally {
    await d.cleanup();
  }
});

test('serve rejects a bad ARTIFACTS_TAILSCALE_WAIT', async () => {
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [BIN, 'serve'], { env: { ...process.env, ARTIFACTS_TAILSCALE_WAIT: 'soon', ARTIFACTS_PUBLIC_URL: '' } }, (err, stdout, stderr) => resolve({ code: err?.code, stderr }));
  });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ARTIFACTS_TAILSCALE_WAIT/);
});
