// Restarts, admin commands (serve/token/gc) and remaining HTTP routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startServer, tempDir, testConfig, Clock, OWNER, file } from './helpers.js';
import { publish } from '../src/cli/client.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

const BIN = fileURLToPath(new URL('../bin/tailnet-artifacts.js', import.meta.url));

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

const pub = (files, options = {}) => publish({ url: s.base, token: s.token, files, options });

function raw(path, { headers = {}, method = 'GET', base = s.base, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { headers, method }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function cli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, XDG_CONFIG_HOME: '/nonexistent', ARTIFACTS_TAILSCALE_BIN: '/nonexistent', ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

// ---- 1. restarts ---------------------------------------------------------------

test('tombstones survive a restart, so expired links still say "expired"', async () => {
  const tmp = await tempDir();
  try {
    const clock = new Clock();
    const cfg = testConfig(tmp.dir, { defaultTtl: '1h' });
    const first = new Store(cfg, { now: clock.now });
    await first.init();
    const { meta } = await first.publish([file('a.html', 'x')], { name: 'Survivor' });
    const kept = await first.publish([file('b.html', 'y')], { name: 'Kept', keep: true });
    clock.advance(3600e3 + 1);
    await first.gc();

    const app = await createApp(cfg, { log: () => {}, now: clock.now });
    const addr = await app.listen();
    try {
      const base = `http://127.0.0.1:${addr.port}`;
      const gone = await raw(`/a/${meta.id}/`, { base });
      assert.equal(gone.status, 410);
      assert.match(gone.body, /Survivor/);
      assert.match(gone.body, /expired/);
      assert.equal((await raw(`/a/${kept.meta.id}/`, { base })).status, 200, 'live artifacts reload too');
    } finally {
      await app.close();
    }
  } finally {
    await tmp.cleanup();
  }
});

test('a corrupt tombstone is ignored on startup', async () => {
  const tmp = await tempDir();
  try {
    const cfg = testConfig(tmp.dir);
    const store = new Store(cfg);
    await store.init();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${tmp.dir}/tombstones/broken-aaaaaaaaaa.json`, '{not json');
    await writeFile(`${tmp.dir}/tombstones/README.txt`, 'ignored');
    const again = new Store(cfg);
    await again.init();
    assert.equal(again.tombstones.size, 0);
  } finally {
    await tmp.cleanup();
  }
});

test('a publish that fails while writing leaves nothing behind', async () => {
  const tmp = await tempDir();
  try {
    const store = new Store(testConfig(tmp.dir));
    await store.init();
    const { readdir } = await import('node:fs/promises');
    // A Buffer-like object that throws when written: forces a failure inside staging.
    const bad = { path: 'z.css', data: { length: 1, buffer: null } };
    await assert.rejects(store.publish([file('index.html', 'x'), bad], { name: 'Broken' }), (e) => {
      assert.ok(!('status' in e), `expected a write error, got validation error: ${e.message}`);
      return true;
    });
    assert.deepEqual(await readdir(`${tmp.dir}/.staging`), []);
    assert.equal(store.list().length, 0);
    assert.equal(store.reservedBytes, 0);
  } finally {
    await tmp.cleanup();
  }
});

// ---- 2. admin commands -----------------------------------------------------------

test('token create / list / revoke', async () => {
  const tmp = await tempDir();
  try {
    const env = { ARTIFACTS_DATA_DIR: tmp.dir };
    const created = await cli(['token', 'create', 'ci-runner'], env);
    assert.equal(created.code, 0);
    assert.match(created.stdout.trim(), /^ta_[A-Za-z0-9_-]{43}$/);
    assert.match(created.stderr, /shown once/);
    assert.equal((await cli(['token', 'create', 'ci-runner'], env)).code, 1, 'duplicate name');
    assert.equal((await cli(['token', 'list'], env)).stdout.trim(), 'ci-runner\tpublish', 'default scope is publish');
    assert.equal((await cli(['token', 'create', 'ops', '--scope', 'admin'], env)).code, 0);
    assert.equal((await cli(['token', 'create', 'x', '--scope', 'root'], env)).code, 2);
    assert.match((await cli(['token', 'list'], env)).stdout, /ops\tadmin/);
    assert.match(created.stderr, /artifacts login /, 'prints the login command');
    assert.equal((await cli(['token', 'revoke', 'ci-runner'], env)).code, 0);
    assert.equal((await cli(['token', 'list'], env)).stdout.trim(), 'ops\tadmin');
    assert.equal((await cli(['token', 'revoke', 'nobody'], env)).code, 1);
    assert.equal((await cli(['token', 'frobnicate'], env)).code, 2);
  } finally {
    await tmp.cleanup();
  }
});

test('gc --dry-run and gc against a stopped server; gc refuses while the server runs', async () => {
  const tmp = await tempDir();
  try {
    const clock = new Clock(Date.now() - 2 * 86400e3);
    const store = new Store(testConfig(tmp.dir, { defaultTtl: '1d' }), { now: clock.now });
    await store.init();
    await store.publish([file('a.html', 'x')], { name: 'Old one' }); // expired a day ago in real time

    const env = { ARTIFACTS_DATA_DIR: tmp.dir, ARTIFACTS_PORT: '49152' };
    const dry = await cli(['gc', '--dry-run'], env);
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /would delete\s+old-one-/);
    assert.match(dry.stdout, /1 artifact\(s\), 0 tombstone\(s\) \(dry run\)/);
    const real = await cli(['gc'], env);
    assert.match(real.stdout, /deleted\s+old-one-/);
    assert.match((await cli(['gc', '--dry-run'], env)).stdout, /0 artifact\(s\)/);

    const port = new URL(s.base).port;
    const busy = await cli(['gc'], { ARTIFACTS_DATA_DIR: tmp.dir, ARTIFACTS_PORT: port });
    assert.equal(busy.code, 1);
    assert.match(JSON.parse(busy.stderr).message, /server is running/);
  } finally {
    await tmp.cleanup();
  }
});

test('serve starts, logs config warnings, serves, and exits cleanly on SIGTERM', async () => {
  const tmp = await tempDir();
  const child = spawn(process.execPath, [BIN, 'serve'], {
    // No tailscale CLI: the server must not detect a public URL from the machine it runs on.
    env: { PATH: process.env.PATH, ARTIFACTS_DATA_DIR: tmp.dir, ARTIFACTS_PORT: '0', ARTIFACTS_TAILSCALE_BIN: '/nonexistent' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const lines = [];
    const rl = createInterface({ input: child.stdout });
    const listening = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no listening line: ${lines.join('\n')}`)), 10000);
      rl.on('line', (l) => {
        lines.push(l);
        const j = JSON.parse(l);
        if (j.message === 'listening') { clearTimeout(t); resolve(j); }
      });
    });
    await new Promise((r) => setTimeout(r, 100)); // let the startup warnings flush
    const warnings = lines.map((l) => JSON.parse(l)).filter((j) => j.level === 'warn').map((j) => j.message).join('\n');
    assert.match(warnings, /no publish tokens/);
    assert.match(warnings, /ARTIFACTS_PUBLIC_URL is not set/);
    assert.match(warnings, /ARTIFACTS_OWNERS is empty/);
    const health = await raw('/healthz', { base: `http://${listening.address}` });
    assert.equal(health.status, 200);
    child.kill('SIGTERM');
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 0);
  } finally {
    child.kill('SIGKILL');
    await tmp.cleanup();
  }
});

test('help, version and unknown commands', async () => {
  assert.match((await cli(['help'])).stdout, /artifacts publish/);
  assert.match((await cli(['--version'])).stdout, /^\d+\.\d+\.\d+\n$/);
  const bad = await cli(['frobnicate']);
  assert.equal(bad.code, 2);
  assert.equal(JSON.parse(bad.stderr).error, 'usage');
  assert.equal((await cli(['publish'])).code, 2, 'publish needs a path');
  assert.equal((await cli(['screenshot', 'not a url'])).code, 2);
});

// ---- 3. remaining routes ---------------------------------------------------------

test('gallery assets are served with the right types; unknown assets 404', async () => {
  for (const [name, type] of [['app.css', 'text/css'], ['app.js', 'text/javascript'], ['shell.js', 'text/javascript'], ['icon.svg', 'image/svg+xml']]) {
    const res = await raw(`/static/${name}`);
    assert.equal(res.status, 200, name);
    assert.ok(res.headers['content-type'].startsWith(type), `${name}: ${res.headers['content-type']}`);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.body.length > 0);
  }
  assert.equal((await raw('/static/server.js')).status, 404);
});

test('list and whoami APIs', async () => {
  const r = await pub([file('a.html', 'x')], { name: 'Listed', by: 'codex' });
  const list = JSON.parse((await raw('/api/artifacts')).body);
  const item = list.artifacts.find((a) => a.id === r.id);
  assert.equal(item.name, 'Listed');
  assert.equal(item.versions[0].by, 'codex');
  assert.equal(item.links.latest, `${s.base}/a/${r.id}/`);

  assert.deepEqual(JSON.parse((await raw('/api/whoami')).body), { viewer: null, token: null, canManage: false });
  const owner = JSON.parse((await raw('/api/whoami', { headers: OWNER })).body);
  assert.equal(owner.viewer.login, 'owner@example.com');
  assert.equal(owner.canManage, true);
  const tok = JSON.parse((await raw('/api/whoami', { headers: { Authorization: `Bearer ${s.token}` } })).body);
  assert.deepEqual(tok.token, { name: 'test-publisher', scope: 'publish' });
});

test('redirects for missing trailing slashes keep the query', async () => {
  const r = await pub([file('index.html', 'x')], { name: 'Slashes' });
  let res = await raw(`/a/${r.id}?v=1`);
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, `/a/${r.id}/?v=1`);
  res = await raw(`/a/${r.id}/v/1?x=2`);
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, `/a/${r.id}/v/1/?x=2`);
});

test('malformed requests get clear 4xx errors', async () => {
  const r = await pub([file('index.html', 'x')], { name: 'Malformed' });
  const badEnc = await raw(`/a/${r.id}/v/1/%E0%A4%A`);
  assert.equal(badEnc.status, 400);

  const badJson = await raw(`/api/artifacts/${r.id}/pin`, { method: 'POST', body: '{nope', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' } });
  assert.equal(badJson.status, 400);
  assert.equal(JSON.parse(badJson.body).error, 'bad_json');

  const badTtl = await raw(`/api/artifacts/${r.id}/extend`, { method: 'POST', body: '{"ttl":"forever"}', headers: { Authorization: `Bearer ${s.token}` } });
  assert.equal(badTtl.status, 400);

  const small = await startServer({ maxPublishSize: '1kb' });
  try {
    const big = Buffer.alloc(3 * 1024 * 1024);
    const res = await fetch(`${small.base}/api/artifacts`, { method: 'POST', body: big, headers: { Authorization: `Bearer ${small.token}`, 'Content-Type': 'application/vnd.tailnet-artifacts.bundle' } });
    assert.equal(res.status, 413);
    assert.match((await res.json()).message, /request is \d+ bytes/);
  } finally {
    await small.stop();
  }
});
