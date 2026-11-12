// Browser tests for the gallery and viewer (src/static/*.js), using Playwright's Chromium.
// Run with: npm run test:browser   (first time: npx playwright install chromium)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer, OWNER, file } from '../helpers.js';
import { publish } from '../../src/cli/client.js';

let s;
let browser;
before(async () => {
  s = await startServer();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await s?.stop();
});

const pub = (files, options = {}) => publish({ url: s.base, token: s.token, files, options });
const html = (body) => `<!doctype html><meta charset=utf-8><body>${body}</body>`;

/** New page; optionally as the owner. Collects console errors and CSP violations. */
async function open(path, { owner = false, allow = [] } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: owner ? OWNER : {},
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !allow.some((re) => re.test(m.text()))) errors.push(m.text());
  });
  await page.goto(`${s.base}${path}`);
  return { page, errors, close: () => context.close() };
}

test('gallery renders without script or CSP errors and shows relative times', async () => {
  const r = await pub([file('a.html', html('x'))], { name: 'Gallery item', by: 'codex' });
  const { page, errors, close } = await open('/');
  try {
    await page.getByRole('link', { name: 'Gallery item' }).waitFor();
    const when = await page.locator('.card time').first().textContent();
    assert.match(when, /now|second|minute/, `relative time, got "${when}"`);
    assert.equal(await page.locator('button[data-action]').count(), 0, 'no owner controls for anonymous viewers');
    assert.deepEqual(errors, []);
    assert.ok(r.id);
  } finally {
    await close();
  }
});

test('live reload: the open viewer switches to a new version by itself', async () => {
  const r = await pub([file('index.html', html('<h1>first</h1>'))], { name: 'Live' });
  const { page, errors, close } = await open(`/a/${r.id}/`);
  try {
    const frame = page.frameLocator('#frame');
    await frame.locator('h1', { hasText: 'first' }).waitFor();
    assert.ok(await page.locator('#live').isVisible(), 'shows live indicator');
    await pub([file('index.html', html('<h1>second</h1>'))], { to: r.id });
    await frame.locator('h1', { hasText: 'second' }).waitFor({ timeout: 5000 });
    await page.locator('#toast', { hasText: 'Updated to v2' }).waitFor();
    assert.equal(await page.locator('#ver').inputValue(), '2');
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test('version picker: an older version stays put and new versions are announced', async () => {
  const r = await pub([file('index.html', html('<h1>one</h1>'))], { name: 'Picker' });
  await pub([file('index.html', html('<h1>two</h1>'))], { to: r.id });
  const { page, errors, close } = await open(`/a/${r.id}/`);
  try {
    await Promise.all([page.waitForURL(/\?v=1$/), page.locator('#ver').selectOption('1')]);
    const frame = page.frameLocator('#frame');
    await frame.locator('h1', { hasText: 'one' }).waitFor();
    assert.equal(await page.locator('#live').isVisible(), false, 'not following latest');
    await pub([file('index.html', html('<h1>three</h1>'))], { to: r.id });
    await page.locator('#toast', { hasText: 'v3 published' }).waitFor({ timeout: 5000 });
    assert.equal(await frame.locator('h1').textContent(), 'one', 'still showing v1');
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test('sandbox: artifact scripts cannot reach the viewer, storage, or owner APIs', async () => {
  const probe = html(`<pre id=out></pre><script>
    const out = [];
    try { parent.document.title; out.push('parent:OPEN'); } catch { out.push('parent:blocked'); }
    try { localStorage.setItem('x', '1'); out.push('storage:OPEN'); } catch { out.push('storage:blocked'); }
    try { document.cookie = 'a=b'; out.push(document.cookie ? 'cookie:OPEN' : 'cookie:blocked'); } catch { out.push('cookie:blocked'); }
    fetch(location.origin + '/api/artifacts/' + ${JSON.stringify('ID')}, { method: 'DELETE', headers: { 'X-Artifacts-Csrf': '1' } })
      .then((r) => out.push('delete:status-' + r.status), () => out.push('delete:blocked'))
      .finally(() => { document.getElementById('out').textContent = out.join(' '); });
  </script>`);
  const r = await pub([file('index.html', 'placeholder')], { name: 'Sandbox probe' });
  await pub([file('index.html', probe.replace('"ID"', JSON.stringify(r.id)))], { to: r.id });
  // Owner identity is attached to every request from this context, including the artifact's own.
  const { page, close } = await open(`/a/${r.id}/`, { owner: true });
  try {
    const out = page.frameLocator('#frame').locator('#out');
    await out.filter({ hasText: 'delete:' }).waitFor({ timeout: 5000 });
    const text = await out.textContent();
    assert.match(text, /parent:blocked/);
    assert.match(text, /storage:blocked/);
    assert.match(text, /cookie:blocked/);
    assert.match(text, /delete:blocked/, `owner API must be unreachable from an artifact: ${text}`);
    assert.equal((await fetch(`${s.base}/api/artifacts/${r.id}`)).status, 200, 'artifact still exists');
  } finally {
    await close();
  }
});

test('owner controls: pin, extend, and two-step delete', async () => {
  const r = await pub([file('a.html', html('x'))], { name: 'Owner target' });
  const { page, errors, close } = await open(`/a/${r.id}/info`, { owner: true });
  try {
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: '+7 days' }).click()]);
    const afterExtend = JSON.parse(await (await fetch(`${s.base}/api/artifacts/${r.id}`)).text()).expiresAt;
    assert.ok(Date.parse(afterExtend) - Date.now() > 13 * 86400e3, 'extended to ~14 days');

    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Pin' }).click()]);
    await page.getByText('Pinned').first().waitFor();
    assert.ok(await page.getByRole('button', { name: 'Unpin' }).isVisible());

    const del = page.getByRole('button', { name: 'Delete' });
    await del.click();
    await page.getByRole('button', { name: 'Confirm delete' }).waitFor();
    assert.equal((await fetch(`${s.base}/api/artifacts/${r.id}`)).status, 200, 'first click only arms');
    await Promise.all([page.waitForURL(`${s.base}/`), page.getByRole('button', { name: 'Confirm delete' }).click()]);
    assert.equal((await fetch(`${s.base}/api/artifacts/${r.id}`)).status, 410);
    assert.equal(await page.getByRole('link', { name: 'Owner target' }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test('an artifact that expires while open turns into the "expired" page', async () => {
  const r = await pub([file('index.html', html('<h1>soon gone</h1>'))], { name: 'Ephemeral', ttl: '1h' });
  const { page, close } = await open(`/a/${r.id}/`, { allow: [/410/] });
  try {
    await page.frameLocator('#frame').locator('h1').waitFor();
    s.clock.advance(3600e3 + 1);
    await Promise.all([page.waitForEvent('load', { timeout: 5000 }), s.app.store.gc()]);
    await page.getByText(/expired on/).waitFor();
    assert.match(await page.locator('h1').textContent(), /Gone/);
  } finally {
    await close();
  }
});

test('a new version of a different kind reloads the viewer with the right sandbox', async () => {
  const r = await pub([file('doc.pdf', '%PDF-1.4\n')], { name: 'Kind change' });
  const { page, close } = await open(`/a/${r.id}/`);
  try {
    assert.equal(await page.locator('#frame').getAttribute('sandbox'), null, 'PDFs are framed without sandbox');
    await Promise.all([page.waitForEvent('load', { timeout: 5000 }), pub([file('index.html', html('<h1>now html</h1>'))], { to: r.id })]);
    await page.frameLocator('#frame').locator('h1', { hasText: 'now html' }).waitFor();
    assert.match(await page.locator('#frame').getAttribute('sandbox'), /allow-scripts/);
    assert.ok(!/allow-same-origin/.test(await page.locator('#frame').getAttribute('sandbox')));
  } finally {
    await close();
  }
});

test('built sites with relative assets and nested pages work in the viewer', async () => {
  const r = await pub([
    file('index.html', html('<link rel=stylesheet href="./assets/app.css"><h1>home</h1><a href="docs/">docs</a><script type=module src="./assets/app.js"></script>')),
    file('assets/app.css', 'h1{color:rgb(255, 0, 0)}'),
    file('assets/app.js', 'document.querySelector("h1").dataset.js = "ran";'),
    file('docs/index.html', html('<link rel=stylesheet href="d.css"><h2>docs page</h2>')),
    file('docs/d.css', 'h2{color:rgb(0, 0, 255)}'),
  ], { name: 'Built site' });
  assert.deepEqual(r.warnings, []);
  const { page, errors, close } = await open(`/a/${r.id}/`);
  try {
    const frame = page.frameLocator('#frame');
    const h1 = frame.locator('h1[data-js="ran"]');
    await h1.waitFor();
    assert.equal(await h1.evaluate((e) => getComputedStyle(e).color), 'rgb(255, 0, 0)');
    await frame.getByRole('link', { name: 'docs' }).click();
    const h2 = frame.locator('h2');
    await h2.waitFor();
    assert.equal(await h2.evaluate((e) => getComputedStyle(e).color), 'rgb(0, 0, 255)');
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test('share uses the system share sheet when the browser has one', async () => {
  const r = await pub([file('index.html', html('<h1>share me</h1>'))], { name: 'Shareable' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    window.__shared = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => { window.__shared.push(data); } });
  });
  const page = await context.newPage();
  try {
    await page.goto(`${s.base}/`);
    await page.locator(`.card:has-text("Shareable") button.share`).click();
    assert.deepEqual(await page.evaluate(() => window.__shared), [{ title: 'Shareable', url: `${s.base}/a/${r.id}/` }]);

    await page.goto(`${s.base}/a/${r.id}/`);
    await page.locator('button.bar-share').click();
    assert.deepEqual((await page.evaluate(() => window.__shared)).at(-1), { title: 'Shareable', url: `${s.base}/a/${r.id}/` });
  } finally {
    await context.close();
  }
});

test('share falls back to copying the link, and shows the platform icon', async () => {
  const r = await pub([file('index.html', html('<h1>copy me</h1>'))], { name: 'Copyable' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: s.base });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'Win32' });
  });
  const page = await context.newPage();
  try {
    await page.goto(`${s.base}/`);
    const btn = page.locator(`.card:has-text("Copyable") button.share`);
    assert.ok(await btn.locator('.share-other').isVisible(), 'three-dots icon off Apple platforms');
    assert.equal(await btn.locator('.share-apple').isVisible(), false);
    await btn.click();
    await page.locator('#toast', { hasText: 'Link copied' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${s.base}/a/${r.id}/`);
  } finally {
    await context.close();
  }

  const mac = await browser.newContext();
  await mac.addInitScript(() => Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' }));
  const p2 = await mac.newPage();
  try {
    await p2.goto(`${s.base}/`);
    assert.ok(await p2.locator(`.card:has-text("Copyable") .share-apple`).isVisible(), 'box-and-arrow icon on Apple platforms');
  } finally {
    await mac.close();
  }
});
