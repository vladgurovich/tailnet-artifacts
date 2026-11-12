import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, detectKind } from '../src/store.js';
import { tempDir, testConfig, Clock, file } from './helpers.js';

async function makeStore(overrides) {
  const tmp = await tempDir();
  const clock = new Clock();
  const store = new Store(testConfig(tmp.dir, overrides), { now: clock.now });
  await store.init();
  return { store, clock, tmp };
}

test('kind detection', () => {
  assert.deepEqual(detectKind([file('mock.html', '')]), { kind: 'html', entry: 'mock.html' });
  assert.deepEqual(detectKind([file('shot.PNG', '')]), { kind: 'image', entry: 'shot.PNG' });
  assert.deepEqual(detectKind([file('spec.md', '')]), { kind: 'markdown', entry: 'spec.md' });
  assert.deepEqual(detectKind([file('doc.pdf', '')]), { kind: 'pdf', entry: 'doc.pdf' });
  assert.deepEqual(detectKind([file('data.zip', '')]), { kind: 'file', entry: 'data.zip' });
  assert.deepEqual(detectKind([file('index.html', ''), file('a.css', '')]), { kind: 'site', entry: 'index.html' });
  assert.deepEqual(detectKind([file('page.html', ''), file('a.css', '')]), { kind: 'site', entry: 'page.html' });
  assert.throws(() => detectKind([file('a.html', ''), file('b.html', '')]), /index.html/);
  assert.deepEqual(detectKind([file('a.html', ''), file('b.html', '')], 'b.html'), { kind: 'site', entry: 'b.html' });
});

test('publish, version, conflict, ttl', async () => {
  const { store, clock, tmp } = await makeStore();
  try {
    const r1 = await store.publish([file('index.html', 'v1')], { name: 'Login Redesign', by: 'codex', publisher: { token: 'dev-box' } });
    assert.match(r1.meta.id, /^login-redesign-[a-z0-9]{10}$/);
    assert.equal(r1.version.n, 1);
    assert.equal(r1.version.by, 'codex');
    assert.equal(r1.meta.visibility, 'private');
    assert.equal(r1.meta.expiresAt, clock.t + 7 * 86400e3);

    clock.advance(86400e3);
    const r2 = await store.publish([file('index.html', 'v2')], { to: r1.meta.id, note: 'tighter spacing', by: 'claude' });
    assert.equal(r2.version.n, 2);
    assert.equal(r2.meta.current, 2);
    assert.equal(r2.meta.expiresAt, clock.t + 7 * 86400e3, 'new version restarts the clock');

    await assert.rejects(store.publish([file('index.html', 'stale')], { to: r1.meta.id, expectedVersion: 1 }), { status: 409 });
    const r3 = await store.publish([file('index.html', 'v3')], { to: r1.meta.id, expectedVersion: 2, keep: true });
    assert.equal(r3.meta.expiresAt, null);
    assert.equal(r3.meta.pinned, true);

    const f = await store.resolveFile(r1.meta.id, 1, '');
    assert.ok(f.path.endsWith(join('v', '1', 'index.html')));
    await assert.rejects(store.publish([file('x.html', '')], { to: 'nope-zzzz' }), { status: 404 });
    await assert.rejects(store.publish([file('x.html', '')], { ttlMs: 400 * 86400e3 }), { status: 400 });
  } finally {
    await tmp.cleanup();
  }
});

test('expiry is effective at request time; gc buries and tombstones are purged', async () => {
  const { store, clock, tmp } = await makeStore({ defaultTtl: '1h', tombstoneTtl: '2d' });
  try {
    const { meta } = await store.publish([file('a.html', 'x')], { name: 'Temp' });
    const kept = await store.publish([file('b.html', 'y')], { name: 'Kept', keep: true });
    assert.equal(store.lookup(meta.id).state, 'live');

    clock.advance(3600e3);
    assert.equal(store.lookup(meta.id).state, 'gone', 'expired before gc runs');
    assert.equal(store.list().length, 1);
    await assert.rejects(store.publish([file('a.html', 'x2')], { to: meta.id }), { status: 410 });

    const dry = await store.gc({ dryRun: true });
    assert.deepEqual(dry.deleted.map((d) => d.id), [meta.id]);
    assert.equal(store.metas.has(meta.id), true, 'dry run changes nothing');

    const r = await store.gc();
    assert.deepEqual(r.deleted.map((d) => d.id), [meta.id]);
    await assert.rejects(access(join(tmp.dir, 'artifacts', meta.id)));
    const gone = store.lookup(meta.id);
    assert.equal(gone.state, 'gone');
    assert.equal(gone.tombstone.name, 'Temp');
    assert.equal(store.lookup(kept.meta.id).state, 'live');

    clock.advance(3 * 86400e3);
    const r2 = await store.gc();
    assert.equal(r2.purgedTombstones, 1);
    assert.equal(store.lookup(meta.id).state, 'missing');
    assert.deepEqual(await readdir(join(tmp.dir, '.trash')), []);
  } finally {
    await tmp.cleanup();
  }
});

test('pin, unpin, extend, delete', async () => {
  const { store, clock, tmp } = await makeStore();
  try {
    const { meta } = await store.publish([file('a.html', 'x')], { name: 'P' });
    let m = await store.setPinned(meta.id, true);
    assert.equal(m.expiresAt, null);
    m = await store.setPinned(meta.id, false);
    assert.equal(m.expiresAt, clock.t + 7 * 86400e3);
    m = await store.extend(meta.id, 86400e3);
    assert.equal(m.expiresAt, clock.t + 8 * 86400e3);
    await store.remove(meta.id);
    assert.equal(store.lookup(meta.id).tombstone.reason, 'deleted');
  } finally {
    await tmp.cleanup();
  }
});

test('limits and unsafe paths', async () => {
  const { store, tmp } = await makeStore({ maxPublishSize: '1kb', maxFiles: 3, maxDataSize: '2kb' });
  try {
    await assert.rejects(store.publish([file('../evil.html', 'x')], {}), { status: 400, code: 'bad_path' });
    await assert.rejects(store.publish([file('/etc/passwd', 'x')], {}), { status: 400 });
    await assert.rejects(store.publish([file('a.html', ''), file('A.html', '')], {}), { code: 'duplicate_path' });
    await assert.rejects(store.publish([file('a', ''), file('a/b.html', '')], {}), { code: 'path_conflict' });
    await assert.rejects(store.publish([file('a.html', 'x'.repeat(2000))], {}), { status: 413 });
    await assert.rejects(store.publish(['1', '2', '3', '4'].map((n) => file(`${n}.html`, '')), {}), { status: 413 });
    await store.publish([file('a.html', 'x'.repeat(1000))], {});
    await store.publish([file('a.html', 'x'.repeat(1000))], {});
    await assert.rejects(store.publish([file('a.html', 'x'.repeat(100))], {}), { status: 507 });
    assert.equal(await store.resolveFile('nope-zzzz', 1, ''), null);
  } finally {
    await tmp.cleanup();
  }
});

test('init recovers from crashes', async () => {
  const { store, tmp } = await makeStore();
  try {
    const { meta } = await store.publish([file('a.html', 'x')], { name: 'Crashy' });
    // Orphan version dir (rename happened, meta write did not) and an artifact dir with no meta.
    await mkdir(join(tmp.dir, 'artifacts', meta.id, 'v', '2'), { recursive: true });
    await mkdir(join(tmp.dir, 'artifacts', 'half-baked-aaaa', 'v', '1'), { recursive: true });
    await writeFile(join(tmp.dir, '.staging', 'leftover'), 'x');

    const fresh = new Store(store.cfg, { now: store.now });
    await fresh.init();
    assert.deepEqual(await readdir(join(tmp.dir, 'artifacts', meta.id, 'v')), ['1']);
    assert.ok(!(await readdir(join(tmp.dir, 'artifacts'))).includes('half-baked-aaaa'));
    assert.deepEqual(await readdir(join(tmp.dir, '.staging')), []);
    const r = await fresh.publish([file('a.html', 'y')], { to: meta.id });
    assert.equal(r.version.n, 2);
  } finally {
    await tmp.cleanup();
  }
});

test('concurrent publishes to the same artifact get distinct versions', async () => {
  const { store, tmp } = await makeStore();
  try {
    const { meta } = await store.publish([file('a.html', '0')], { name: 'Race' });
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => store.publish([file('a.html', String(i))], { to: meta.id })));
    assert.deepEqual(results.map((r) => r.version.n).sort(), [2, 3, 4, 5, 6]);
  } finally {
    await tmp.cleanup();
  }
});
