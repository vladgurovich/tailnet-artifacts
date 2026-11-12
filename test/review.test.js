// Regression tests for the v0.2.0 security and usability review.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, tempDir, testConfig, Clock, file } from './helpers.js';
import { publish, collectFiles, CliError } from '../src/cli/client.js';
import { encodeBundle, BUNDLE_TYPE } from '../src/wire.js';
import { Store } from '../src/store.js';
import { ID_RE, randomSuffix } from '../src/util.js';

const BIN = fileURLToPath(new URL('../bin/tailnet-artifacts.js', import.meta.url));

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

const pub = (files, options = {}) => publish({ url: s.base, token: s.token, files, options });

function raw(path, { headers = {}, method = 'GET', base = s.base } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { headers, method }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

function cli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, XDG_CONFIG_HOME: '/nonexistent', ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

const openFds = () => readdirSync('/dev/fd').length;

// ---- #1 / #2: streaming --------------------------------------------------------

test('#1 deleting an artifact while it is being downloaded does not crash the server', async () => {
  const r = await pub([file('index.html', '<link rel=stylesheet href=f.css>'), file('f.css', 'x'.repeat(200_000))], { name: 'Race' });
  const gets = Array.from({ length: 60 }, () => raw(`/a/${r.id}/v/1/f.css`).catch(() => null));
  await new Promise((res) => setImmediate(res));
  await s.app.store.remove(r.id);
  await s.app.store.gc();
  const results = await Promise.all(gets);
  assert.ok(results.every((x) => !x || [200, 404, 410].includes(x.status)));
  assert.equal((await raw('/healthz')).status, 200, 'server is still up');
});

test('#2 aborted downloads release their file descriptors', async () => {
  const r = await pub([{ path: 'big.bin', data: Buffer.alloc(8 * 1024 * 1024, 1) }], { name: 'Big' });
  const before = openFds();
  await Promise.all(Array.from({ length: 12 }, () => new Promise((resolve) => {
    const req = request(`${s.base}/a/${r.id}/v/1/big.bin`, (res) => {
      res.once('data', () => { req.destroy(); setTimeout(resolve, 20); });
    });
    req.on('error', () => resolve());
    req.end();
  })));
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(openFds() - before < 4, `fds grew from ${before} to ${openFds()}`);
});

test('#2 range requests and ETags', async () => {
  const r = await pub([file('clip.txt', '0123456789')], { name: 'Range' });
  const p = `/a/${r.id}/v/1/clip.txt`;
  let res = await raw(p, { headers: { Range: 'bytes=2-5' } });
  assert.equal(res.status, 206);
  assert.equal(res.body, '2345');
  assert.equal(res.headers['content-range'], 'bytes 2-5/10');
  res = await raw(p, { headers: { Range: 'bytes=-3' } });
  assert.equal(res.body, '789');
  res = await raw(p, { headers: { Range: 'bytes=50-' } });
  assert.equal(res.status, 416);
  assert.equal(res.headers['content-range'], 'bytes */10');
  const full = await raw(p);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['cache-control'], 'private, no-cache');
  res = await raw(p, { headers: { 'If-None-Match': full.headers.etag } });
  assert.equal(res.status, 304);
  const head = await raw(p, { method: 'HEAD' });
  assert.equal(head.headers['content-length'], '10');
});

// ---- #3 / #4: builds and directories ------------------------------------------

test('#3 publish warns about root-absolute asset paths', async () => {
  const bad = await pub([file('index.html', '<script type="module" src="/assets/index-abc.js"></script><link href="/assets/x.css" rel=stylesheet>'), file('assets/index-abc.js', '')], { name: 'Vite default' });
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /\/assets\/index-abc\.js/);
  assert.match(bad.warnings[0], /--base \.\//);
  const good = await pub([file('index.html', '<script src="./assets/a.js"></script><img src="//cdn.example/x.png"><a href="https://x.dev/">x</a>'), file('assets/a.js', '')], { name: 'Relative' });
  assert.deepEqual(good.warnings, []);
});

test('#4 nested directories and sub-directory entries are served with correct bases', async () => {
  const r = await pub([
    file('index.html', 'root'), file('docs/index.html', '<link href="a.css">docs'), file('docs/a.css', 'css'),
  ], { name: 'Nested' });
  const slash = await raw(`/a/${r.id}/v/1/docs/`);
  assert.equal(slash.status, 200);
  assert.equal(slash.body, '<link href="a.css">docs');
  const noSlash = await raw(`/a/${r.id}/v/1/docs?x=1`);
  assert.equal(noSlash.status, 301);
  assert.equal(noSlash.headers.location, `/a/${r.id}/v/1/docs/?x=1`);

  const sub = await pub([file('build/index.html', '<script src="app.js"></script>'), file('build/app.js', '1')], { name: 'Sub entry' });
  const root = await raw(`/a/${sub.id}/v/1/`);
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, `/a/${sub.id}/v/1/build/index.html`);
  assert.equal((await raw(`/a/${sub.id}/v/1/build/app.js`)).body, '1');
});

// ---- #5: host header -----------------------------------------------------------

test('#5 requests with an unexpected Host are rejected', async () => {
  const r = await pub([file('a.html', 'x')], { name: 'Host' });
  const evil = await raw(`/api/artifacts/${r.id}`, { method: 'DELETE', headers: { Host: 'rebind.attacker.example:8790', 'tailscale-user-login': 'owner@example.com', 'x-artifacts-csrf': '1', 'sec-fetch-site': 'same-origin' } });
  assert.equal(evil.status, 421);
  assert.equal((await raw(`/a/${r.id}/`)).status, 200, 'artifact untouched');
  assert.equal((await raw('/', { headers: { Host: 'localhost:1234' } })).status, 200);

  const pubd = await startServer({ publicUrl: 'https://artifacts.example.ts.net' });
  try {
    assert.equal((await raw('/', { base: pubd.base, headers: { Host: 'artifacts.example.ts.net' } })).status, 200);
    assert.equal((await raw('/', { base: pubd.base, headers: { Host: 'other.example.ts.net' } })).status, 421);
  } finally {
    await pubd.stop();
  }
});

// ---- #6: CLI file collection ---------------------------------------------------

test('#6 CLI skips dotfiles and node_modules unless asked, and checks limits first', async () => {
  const tmp = await tempDir();
  try {
    const d = join(tmp.dir, 'proj');
    await mkdir(join(d, 'node_modules', 'x'), { recursive: true });
    await mkdir(join(d, 'sub'), { recursive: true });
    await mkdir(join(d, '.git'), { recursive: true });
    for (const [p, c] of [['index.html', 'i'], ['.env', 'SECRET=1'], ['.npmrc', '//registry:_authToken=x'], ['node_modules/x/i.js', 'm'], ['sub/ok.css', 'c'], ['sub/.hidden', 'h'], ['.git/config', 'g']]) {
      await writeFile(join(d, p), c);
    }
    const skipped = [];
    const files = await collectFiles(d, { onSkip: (p) => skipped.push(p) });
    assert.deepEqual(files.map((f) => f.path), ['index.html', 'sub/ok.css']);
    assert.deepEqual(skipped.sort(), ['.env', '.npmrc', 'node_modules/', 'sub/.hidden']);
    const all = await collectFiles(d, { includeHidden: true });
    assert.deepEqual(all.map((f) => f.path).sort(), ['.env', '.npmrc', 'index.html', 'node_modules/x/i.js', 'sub/.hidden', 'sub/ok.css']);
    await assert.rejects(collectFiles(d, { maxBytes: 1 }), (e) => e instanceof CliError && e.exitCode === 6);
    await assert.rejects(collectFiles(d, { maxFiles: 1 }), (e) => e instanceof CliError && e.code === 'too_many_files');
    await assert.rejects(collectFiles(join(d, 'missing')), (e) => e.exitCode === 2);
  } finally {
    await tmp.cleanup();
  }
});

// ---- #7: IDs and uniform content responses ------------------------------------

test('#7 IDs are long and random; v0.1 IDs still route', () => {
  const seen = new Set(Array.from({ length: 2000 }, () => randomSuffix()));
  assert.equal(seen.size, 2000);
  for (const x of seen) assert.match(x, /^[a-z0-9]{10}$/);
  assert.ok(ID_RE.test('hello-world-s50j'), 'old 4-char suffix');
  assert.ok(ID_RE.test('artifact-k3f9x2m8q1'));
});

test('#7 errors inside the content route carry the same CORS and sandbox headers', async () => {
  const miss = await raw('/a/nope-aaaaaaaaaa/v/1/x.js');
  assert.equal(miss.status, 404);
  assert.equal(miss.headers['access-control-allow-origin'], 'null');
  assert.match(miss.headers['content-security-policy'], /^sandbox /);
  const r = await pub([file('a.html', 'x')], { name: 'Soon gone', ttl: '1h' });
  s.clock.advance(3600e3 + 1);
  const gone = await raw(`/a/${r.id}/v/1/`);
  assert.equal(gone.status, 410);
  assert.equal(gone.headers['access-control-allow-origin'], 'null');
});

// ---- #8 / #9: TTL and expected version ----------------------------------------

test('#8 a new version keeps the artifact TTL and never shortens expiry', async () => {
  const tmp = await tempDir();
  try {
    const clock = new Clock();
    const store = new Store(testConfig(tmp.dir), { now: clock.now });
    await store.init();
    const day = 86400e3;
    const { meta } = await store.publish([file('a.html', '1')], { name: 'Long', ttlMs: 30 * day });
    clock.advance(day);
    let r = await store.publish([file('a.html', '2')], { to: meta.id });
    assert.equal(r.meta.ttlMs, 30 * day);
    assert.equal(r.meta.expiresAt, clock.t + 30 * day);
    r = await store.publish([file('a.html', '3')], { to: meta.id, ttlMs: day });
    assert.equal(r.meta.expiresAt, clock.t + day, 'an explicit ttl is honored');

    const ext = await store.publish([file('b.html', '1')], { name: 'Extended' });
    await store.extend(ext.meta.id, 20 * day); // now expires in 27 days
    const after = await store.publish([file('b.html', '2')], { to: ext.meta.id });
    assert.equal(after.meta.expiresAt, clock.t + 27 * day, 'implicit publish never moves expiry earlier');
  } finally {
    await tmp.cleanup();
  }
});

test('#9 a non-integer expectedVersion is rejected, not ignored', async () => {
  const r = await pub([file('a.html', '1')], { name: 'Expect' });
  const body = encodeBundle([file('a.html', '2')], { expectedVersion: 'abc' });
  const res = await fetch(`${s.base}/api/artifacts/${r.id}/versions`, { method: 'POST', body, headers: { 'Content-Type': BUNDLE_TYPE, Authorization: `Bearer ${s.token}` } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_expected_version');

  const out = await cli(['publish', '/dev/null', '--to', r.id, '--expected-version', 'abc'], { ARTIFACTS_URL: s.base, ARTIFACTS_TOKEN: s.token });
  assert.equal(out.code, 2);
  assert.equal(JSON.parse(out.stderr).error, 'usage');
});

// ---- #10: CLI errors -----------------------------------------------------------

test('#10 CLI reports the network cause and uses distinct exit codes', async () => {
  const tmp = await tempDir();
  try {
    const f = join(tmp.dir, 'a.html');
    await writeFile(f, 'x');
    const net = await cli(['publish', f], { ARTIFACTS_URL: 'http://127.0.0.1:49151', ARTIFACTS_TOKEN: 'ta_x' });
    assert.equal(net.code, 7);
    const err = JSON.parse(net.stderr);
    assert.equal(err.error, 'network');
    assert.match(err.message, /ECONNREFUSED/);

    const auth = await cli(['publish', f], { ARTIFACTS_URL: s.base, ARTIFACTS_TOKEN: 'ta_wrongwrongwrongwrong' });
    assert.equal(auth.code, 3);
    assert.equal(JSON.parse(auth.stderr).status, 401);

    const ok = await cli(['publish', f, '--name', 'CLI ok', '--url-only'], { ARTIFACTS_URL: s.base, ARTIFACTS_TOKEN: s.token });
    assert.equal(ok.code, 0);
    assert.match(ok.stdout.trim(), /\/a\/cli-ok-[a-z0-9]{10}\/$/);

    const unknown = await cli(['publish', f, '--bogus']);
    assert.equal(unknown.code, 2);
  } finally {
    await tmp.cleanup();
  }
});

// ---- #11 / #12: viewing and hardening -----------------------------------------

test('#11 text files are viewable inline and escaped; scripts are off in viewer pages', async () => {
  const r = await pub([file('run.log', 'line 1\n<script>alert(1)</script>\n')], { name: 'Log' });
  assert.equal(r.kind, 'text');
  const page = await raw(`/a/${r.id}/v/1/`);
  assert.match(page.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(page.headers['content-security-policy'], /script-src 'none'/);
  const rawFile = await raw(`/a/${r.id}/v/1/run.log`);
  assert.equal(rawFile.headers['content-disposition'], undefined, 'not forced to download');

  const md = await pub([file('n.md', '# Hi\n<script>alert(1)</script>')], { name: 'MD' });
  assert.match((await raw(`/a/${md.id}/v/1/`)).headers['content-security-policy'], /script-src 'none'/);
});

test('#11 shell knows the kind and live events carry it', async () => {
  const r = await pub([file('doc.pdf', '%PDF-1.4')], { name: 'Kind switch' });
  assert.match((await raw(`/a/${r.id}/`)).body, /data-kind="pdf"/);
  const ac = new AbortController();
  const res = await fetch(`${s.base}/api/artifacts/${r.id}/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  let buf = '';
  const dec = new TextDecoder();
  const until = async (needle) => { while (!buf.includes(needle)) buf += dec.decode((await reader.read()).value); };
  await until('event: hello');
  await pub([file('index.html', 'now html')], { to: r.id });
  await until('event: published');
  assert.match(buf, /"kind":"html"/);
  ac.abort();
});

test('#12 trusted pages use a per-response script nonce', async () => {
  const a = await raw('/');
  const b = await raw('/');
  const nonceA = /'nonce-([^']+)'/.exec(a.headers['content-security-policy'])[1];
  const nonceB = /'nonce-([^']+)'/.exec(b.headers['content-security-policy'])[1];
  assert.notEqual(nonceA, nonceB);
  assert.ok(a.body.includes(`nonce="${nonceA}"`));
  assert.ok(!a.body.includes('__TA_CSP_NONCE__'));
});

test('#12 concurrent publishes cannot overshoot the storage cap', async () => {
  const tmp = await tempDir();
  try {
    const store = new Store(testConfig(tmp.dir, { maxDataSize: '1kb' }));
    await store.init();
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => store.publish([file('a.html', 'x'.repeat(400))], { name: `c${i}` })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    assert.ok(store.totalBytes() <= 1024);
    assert.equal(store.reservedBytes, 0);
  } finally {
    await tmp.cleanup();
  }
});

test('#13 /latest/ keeps the query string', async () => {
  const r = await pub([file('index.html', 'x')], { name: 'Latest' });
  const res = await raw(`/a/${r.id}/latest/?debug=1`);
  assert.equal(res.headers.location, `/a/${r.id}/v/1/?debug=1`);
});
