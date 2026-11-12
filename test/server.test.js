import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startServer, OWNER, STRANGER, file } from './helpers.js';
import { publish } from '../src/cli/client.js';
import { encodeBundle, BUNDLE_TYPE } from '../src/wire.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

const pub = (files, options = {}) => publish({ url: s.base, token: s.token, files, options });

/** Raw request (fetch normalizes paths, which would hide traversal attempts). */
function raw(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${s.base}${path}`, { headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('publishing requires a valid token', async () => {
  const body = encodeBundle([file('a.html', 'x')], { name: 'x' });
  let res = await fetch(`${s.base}/api/artifacts`, { method: 'POST', body, headers: { 'Content-Type': BUNDLE_TYPE } });
  assert.equal(res.status, 401);
  res = await fetch(`${s.base}/api/artifacts`, { method: 'POST', body, headers: { 'Content-Type': BUNDLE_TYPE, Authorization: 'Bearer ta_wrongwrongwrongwrong' } });
  assert.equal(res.status, 401);
  // Tailscale identity alone is not enough to publish.
  res = await fetch(`${s.base}/api/artifacts`, { method: 'POST', body, headers: { 'Content-Type': BUNDLE_TYPE, ...OWNER } });
  assert.equal(res.status, 401);
  res = await fetch(`${s.base}/api/artifacts`, { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${s.token}` } });
  assert.equal(res.status, 415);
});

test('publish returns links; shell, info and content are served with the right headers', async () => {
  const r = await pub([file('index.html', '<h1>Hello</h1>'), file('app.css', 'h1{color:red}')], { name: 'Hello Site', by: 'ci/github-actions', note: 'first cut' });
  assert.equal(r.version, 1);
  assert.equal(r.kind, 'site');
  assert.equal(r.links.latest, `${s.base}/a/${r.id}/`);
  assert.equal(r.links.raw, `${s.base}/a/${r.id}/v/1/`);

  const shell = await raw(`/a/${r.id}/`);
  assert.equal(shell.status, 200);
  assert.match(shell.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(shell.headers['content-security-policy'], /script-src 'self';/);
  assert.equal(shell.headers['x-frame-options'], 'DENY');
  assert.match(shell.body, /<iframe id="frame"[^>]+sandbox="allow-scripts/);
  assert.ok(!shell.body.includes('<h1>Hello</h1>'), 'trusted page never inlines content');

  const content = await raw(`/a/${r.id}/v/1/`);
  assert.equal(content.status, 200);
  assert.equal(content.body, '<h1>Hello</h1>');
  assert.match(content.headers['content-security-policy'], /^sandbox allow-scripts /);
  assert.ok(!/allow-same-origin/.test(content.headers['content-security-policy']));
  assert.equal(content.headers['x-content-type-options'], 'nosniff');
  assert.equal(content.headers['access-control-allow-origin'], 'null');

  const css = await raw(`/a/${r.id}/v/1/app.css`);
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  assert.match(css.headers['content-security-policy'], /^sandbox /);

  const info = await raw(`/a/${r.id}/info`);
  assert.match(info.body, /first cut/);
  assert.match(info.body, /ci\/github-actions/);

  const latest = await raw(`/a/${r.id}/latest/app.css`);
  assert.equal(latest.status, 302);
  assert.equal(latest.headers.location, `/a/${r.id}/v/1/app.css`);

  const api = await (await fetch(`${s.base}/api/artifacts/${r.id}`)).json();
  assert.equal(api.versions[0].by, 'ci/github-actions');
  assert.equal(api.versions[0].publisher.token, 'test-publisher');
  assert.equal(api.visibility, 'private');
});

test('path traversal in URLs is refused', async () => {
  const r = await pub([file('index.html', 'x')], { name: 'Traversal' });
  for (const p of [
    `/a/${r.id}/v/1/../meta.json`,
    `/a/${r.id}/v/1/..%2fmeta.json`,
    `/a/${r.id}/v/1/%2e%2e/meta.json`,
    `/a/${r.id}/v/1/..%2f..%2f..%2ftokens`,
    `/a/${r.id}/v/1/%00`,
  ]) {
    const res = await raw(p);
    assert.ok([400, 404].includes(res.status), `${p} -> ${res.status}`);
    assert.ok(!res.body.includes('"versions"') && !res.body.includes('sha256:'), `${p} leaked data`);
  }
});

test('single-file kinds get viewer pages', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const img = await pub([{ path: 'shot.png', data: png }], { name: 'Shot' });
  const page = await raw(`/a/${img.id}/v/1/`);
  assert.match(page.body, /<img src="shot.png"/);
  assert.match(page.headers['content-security-policy'], /^sandbox /);
  const bytes = await fetch(`${s.base}/a/${img.id}/v/1/shot.png`);
  assert.equal(bytes.headers.get('content-type'), 'image/png');

  const md = await pub([file('spec.md', '# Title\n\n<script>alert(1)</script>\n\n- a\n- b')], { name: 'Spec' });
  const mdPage = await raw(`/a/${md.id}/v/1/`);
  assert.match(mdPage.body, /<h1>Title<\/h1>/);
  assert.match(mdPage.body, /<li>a<\/li>/);
  assert.match(mdPage.headers['content-security-policy'], /^sandbox /, 'rendered markdown is sandboxed');

  const pdf = await pub([file('doc.pdf', '%PDF-1.4')], { name: 'Doc' });
  const pdfRes = await raw(`/a/${pdf.id}/v/1/`);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  assert.ok(!/sandbox/.test(pdfRes.headers['content-security-policy']), 'Chromium cannot render sandboxed PDFs');
  const pdfShell = await raw(`/a/${pdf.id}/`);
  assert.ok(!/<iframe[^>]+sandbox=/.test(pdfShell.body));
});

test('gallery lists artifacts and shows owner controls only to owners', async () => {
  const r = await pub([file('a.html', 'x')], { name: 'Gallery <Item>' });
  const anon = await raw('/');
  assert.equal(anon.status, 200);
  assert.match(anon.body, /Gallery &lt;Item&gt;/, 'names are escaped');
  assert.ok(!anon.body.includes('data-action="delete"'));
  const guest = await raw('/', STRANGER);
  assert.ok(!guest.body.includes('data-action="delete"'));
  const owner = await raw('/', OWNER);
  assert.ok(owner.body.includes(`data-id="${r.id}"`));
  assert.ok(owner.body.includes('data-action="delete"'));
});

test('owner actions require owner identity and CSRF header; tokens also work', async () => {
  const r = await pub([file('a.html', 'x')], { name: 'Managed' });
  const url = `${s.base}/api/artifacts/${r.id}/pin`;
  const json = { 'Content-Type': 'application/json' };
  const body = JSON.stringify({ pinned: true });

  assert.equal((await fetch(url, { method: 'POST', body, headers: json })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', body, headers: { ...json, ...STRANGER, 'X-Artifacts-Csrf': '1' } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', body, headers: { ...json, ...OWNER } })).status, 403, 'missing CSRF header');
  assert.equal((await fetch(url, { method: 'POST', body, headers: { ...json, ...OWNER, 'X-Artifacts-Csrf': '1', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);

  let res = await fetch(url, { method: 'POST', body, headers: { ...json, ...OWNER, 'X-Artifacts-Csrf': '1', 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).expiresAt, null);

  res = await fetch(`${s.base}/api/artifacts/${r.id}/extend`, { method: 'POST', body: JSON.stringify({ ttl: '1d' }), headers: { ...json, Authorization: `Bearer ${s.token}` } });
  assert.equal(res.status, 200);

  res = await fetch(`${s.base}/api/artifacts/${r.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${s.token}` } });
  assert.equal(res.status, 200);
  const gone = await raw(`/a/${r.id}/`);
  assert.equal(gone.status, 410);
  assert.match(gone.body, /was deleted/);
});

test('expired artifacts return 410 immediately, before gc', async () => {
  const r = await pub([file('a.html', 'x')], { name: 'Short lived', ttl: '1h' });
  assert.equal((await raw(`/a/${r.id}/v/1/`)).status, 200);
  s.clock.advance(3600e3 + 1);
  const res = await raw(`/a/${r.id}/v/1/`);
  assert.equal(res.status, 410);
  assert.match(res.body, /Short lived/);
  assert.match(res.body, /expired/);
  const api = await fetch(`${s.base}/api/artifacts/${r.id}`);
  assert.equal(api.status, 410);
  await assert.rejects(pub([file('a.html', 'y')], { to: r.id }), { status: 410 });
});

test('conflicting publish is rejected with the current version', async () => {
  const r = await pub([file('a.html', '1')], { name: 'Conflict' });
  await pub([file('a.html', '2')], { to: r.id, expectedVersion: 1 });
  await assert.rejects(pub([file('a.html', '3')], { to: r.id, expectedVersion: 1 }), (e) => e.status === 409 && e.body.current === 2);
});

test('live reload: viewers get an event when a version is published', async () => {
  const r = await pub([file('a.html', '1')], { name: 'Live' });
  const ac = new AbortController();
  const res = await fetch(`${s.base}/api/artifacts/${r.id}/events`, { signal: ac.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const waitFor = async (needle) => {
    while (!buf.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buf += dec.decode(value);
    }
  };
  await waitFor('event: hello');
  await pub([file('a.html', '2')], { to: r.id });
  await waitFor('event: published');
  assert.match(buf, /"version":2/);
  ac.abort();
});

test('oversized publishes are rejected', async () => {
  const big = await startServer({ maxPublishSize: '1kb' });
  try {
    await assert.rejects(publish({ url: big.base, token: big.token, files: [file('a.html', 'x'.repeat(5000))], options: {} }), { status: 413 });
  } finally {
    await big.stop();
  }
});

test('healthz and unknown routes', async () => {
  const h = await (await fetch(`${s.base}/healthz`)).json();
  assert.equal(h.ok, true);
  assert.equal((await fetch(`${s.base}/api/nope`)).status, 404);
  assert.equal((await raw('/static/../server.js')).status, 404);
  assert.equal((await raw('/a/does-not-exist-zzzz/')).status, 404);
});
