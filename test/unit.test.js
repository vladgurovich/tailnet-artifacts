import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDuration, parseSize, slugify, safeRelPath, cleanLabel, ID_RE } from '../src/util.js';
import { encodeBundle, decodeBundle } from '../src/wire.js';
import { TokenStore } from '../src/tokens.js';
import { normalize, DEFAULTS } from '../src/config.js';
import { tailscale } from '../src/identity.js';
import { tempDir, file } from './helpers.js';

test('parseDuration', () => {
  assert.equal(parseDuration('90s'), 90e3);
  assert.equal(parseDuration('15m'), 15 * 60e3);
  assert.equal(parseDuration('12h'), 12 * 3600e3);
  assert.equal(parseDuration('7d'), 7 * 86400e3);
  assert.equal(parseDuration('2w'), 14 * 86400e3);
  assert.equal(parseDuration(5000), 5000);
  assert.throws(() => parseDuration('7 days'));
  assert.throws(() => parseDuration('-1d'));
});

test('parseSize', () => {
  assert.equal(parseSize('50MB'), 50 * 1024 ** 2);
  assert.equal(parseSize('8gb'), 8 * 1024 ** 3);
  assert.equal(parseSize('100'), 100);
  assert.throws(() => parseSize('lots'));
});

test('slugify and ids', () => {
  assert.equal(slugify('Login Redesign — v2!'), 'login-redesign-v2');
  assert.equal(slugify('Café déjà vu'), 'cafe-deja-vu');
  assert.equal(slugify('   '), 'artifact');
  assert.ok(slugify('x'.repeat(100)).length <= 40);
  assert.ok(ID_RE.test('login-redesign-k3f9'));
  assert.ok(!ID_RE.test('../etc-k3f9'));
});

test('safeRelPath rejects traversal and odd paths', () => {
  assert.equal(safeRelPath('index.html'), 'index.html');
  assert.equal(safeRelPath('assets/app.js'), 'assets/app.js');
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', './a', 'a\\b', 'a\0b', 'a/./b', 'x/']) {
    assert.equal(safeRelPath(bad), null, JSON.stringify(bad));
  }
});

test('cleanLabel accepts arbitrary sources and strips control chars', () => {
  assert.equal(cleanLabel('ci/github-actions'), 'ci/github-actions');
  assert.equal(cleanLabel('codex\n\x1b[31m'), 'codex[31m');
  assert.equal(cleanLabel('  '), null);
  assert.equal(cleanLabel('x'.repeat(200)).length, 80);
});

test('bundle round trip', () => {
  const files = [file('index.html', '<h1>hi</h1>'), file('a/b.css', 'body{}'), file('empty.txt', '')];
  const buf = encodeBundle(files, { name: 'Test', ttl: '1d' });
  const { files: out, options } = decodeBundle(buf);
  assert.deepEqual(options, { name: 'Test', ttl: '1d' });
  assert.deepEqual(out.map((f) => [f.path, f.data.toString()]), files.map((f) => [f.path, f.data.toString()]));
});

test('bundle rejects malformed bodies', () => {
  const good = encodeBundle([file('a.txt', 'abc')]);
  assert.throws(() => decodeBundle(Buffer.from('not json\nxx')), /not valid JSON/);
  assert.throws(() => decodeBundle(good.subarray(0, good.length - 1)), /shorter/);
  assert.throws(() => decodeBundle(Buffer.concat([good, Buffer.from('x')])), /longer/);
  assert.throws(() => decodeBundle(Buffer.from('{"v":2,"files":[]}\n')), /unsupported/);
});

test('token store keeps only hashes and supports revoke', async () => {
  const tmp = await tempDir();
  try {
    const path = join(tmp.dir, 'tokens');
    const ts = new TokenStore(path);
    const t = ts.create('dev-box');
    assert.match(t, /^ta_/);
    const text = await readFile(path, 'utf8');
    assert.ok(!text.includes(t), 'plaintext token must not be stored');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(ts.verify(t), { name: 'dev-box', scope: 'publish' });
    assert.equal(ts.verify(`${t}x`), null);
    assert.throws(() => ts.create('dev-box'), /already exists/);
    const t2 = ts.create('mac');
    // A second instance (e.g. the running server) sees the file change.
    const reader = new TokenStore(path);
    assert.deepEqual(reader.verify(t2), { name: 'mac', scope: 'publish' });
    assert.ok(ts.revoke('dev-box'));
    assert.equal(new TokenStore(path).verify(t), null);
    assert.throws(() => ts.create('bad name'), /invalid token name/);
  } finally {
    await tmp.cleanup();
  }
});

test('config normalization', () => {
  const cfg = normalize({ ...DEFAULTS, owners: 'A@x.com, b@y.com', dataDir: '/tmp/x' });
  assert.deepEqual(cfg.owners, ['a@x.com', 'b@y.com']);
  assert.equal(cfg.tokensFile, '/tmp/x/tokens');
  assert.equal(cfg.defaultTtlMs, 7 * 86400e3);
  assert.throws(() => normalize({ ...DEFAULTS, identity: 'magic' }));
});

test('tailscale identity adapter', () => {
  assert.equal(tailscale.identify({ headers: {} }), null);
  const who = tailscale.identify({ headers: { 'tailscale-user-login': 'Someone@Example.com', 'tailscale-user-name': '=?utf-8?q?Jos=C3=A9_P?=' } });
  assert.deepEqual(who, { login: 'someone@example.com', name: 'José P', provider: 'tailscale' });
});
