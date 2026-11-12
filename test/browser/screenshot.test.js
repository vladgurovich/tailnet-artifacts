// `artifacts screenshot` end to end: Playwright CLI (pinned version) -> PNG -> publish.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer, file } from '../helpers.js';
import { publish, PLAYWRIGHT_SPEC } from '../../src/cli/client.js';

const BIN = fileURLToPath(new URL('../../bin/tailnet-artifacts.js', import.meta.url));

let s;
before(async () => { s = await startServer(); });
after(async () => { await s?.stop(); });

function cli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        XDG_CONFIG_HOME: '/nonexistent',
        ARTIFACTS_URL: s.base,
        ARTIFACTS_TOKEN: s.token,
        ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
        ...env,
      },
      timeout: 120000,
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

/** Width and height from a PNG's IHDR chunk. */
async function pngSize(url) {
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const shotDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('artifacts-shot-')).length;

test('screenshot uses the Playwright version this package pins', () => {
  assert.match(PLAYWRIGHT_SPEC, /^playwright@\d+\.\d+\.\d+$/);
});

test('screenshot --mobile publishes a phone-width PNG; --to adds a version', async () => {
  const page = await publish({
    url: s.base, token: s.token,
    files: [file('index.html', '<!doctype html><body style="margin:0;height:1500px;background:#4f46e5"><h1>Tall page</h1>')],
    options: { name: 'Target page' },
  });
  const target = `${s.base}/a/${page.id}/v/1/`;

  const first = await cli(['screenshot', target, '--mobile', '--name', 'Phone shot', '--by', 'test']);
  assert.equal(first.code, 0, first.stderr);
  const r = JSON.parse(first.stdout);
  assert.equal(r.kind, 'image');
  assert.equal(r.name, 'Phone shot');
  const meta = await (await fetch(`${s.base}/api/artifacts/${r.id}`)).json();
  assert.equal(meta.versions[0].by, 'test');
  assert.match(meta.versions[0].note, /Screenshot of .* \(mobile\)/);
  const mobile = await pngSize(`${s.base}/a/${r.id}/v/1/screenshot.png`);
  assert.equal(mobile.width, 390);
  assert.ok(mobile.height >= 1500, `full page, got height ${mobile.height}`);

  const second = await cli(['screenshot', target, '--viewport', '800,600', '--no-full-page', '--to', r.id, '--url-only']);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout.trim(), `${s.base}/a/${r.id}/`);
  assert.deepEqual(await pngSize(`${s.base}/a/${r.id}/v/2/screenshot.png`), { width: 800, height: 600 });
});

test('a failed screenshot reports why and leaves no temp files', async () => {
  const before = shotDirs();
  // FORCE_COLOR makes Playwright emit colour codes, which must not reach the JSON error.
  const res = await cli(['screenshot', 'http://127.0.0.1:49151/nothing-here'], { FORCE_COLOR: '1' });
  assert.equal(res.code, 1);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error, 'screenshot_failed');
  assert.match(err.message, /127\.0\.0\.1:49151/);
  assert.match(err.message, /playwright@\d/);
  assert.match(err.message, /ERR_CONNECTION_REFUSED/, 'the real cause is included');
  assert.ok(!err.message.includes('\x1b['), 'no terminal colour codes');
  assert.equal(shotDirs(), before, 'temp directory removed');
});

test('a missing browser gets an install hint', async () => {
  const res = await cli(['screenshot', `${s.base}/healthz`], { PLAYWRIGHT_BROWSERS_PATH: '/nonexistent-browsers' });
  assert.equal(res.code, 1);
  assert.match(JSON.parse(res.stderr).message, /Install the browser with: npx -y playwright@[\d.]+ install chromium/);
});

test('screenshot validates its arguments before launching a browser', async () => {
  const bad = await cli(['screenshot', `${s.base}/`, '--viewport', 'huge']);
  assert.equal(bad.code, 2);
  assert.match(JSON.parse(bad.stderr).message, /--viewport must look like 1280,800/);
});
