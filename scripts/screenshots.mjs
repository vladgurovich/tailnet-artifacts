// Regenerates the README images from a throwaway server with neutral demo content:
//   node scripts/screenshots.mjs
// Writes docs/images/overview.png (phones), desktop-gallery.png and desktop-viewer.png.
// Needs the dev dependencies (Playwright + Chromium: npx playwright install chromium).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { normalize, DEFAULTS } from '../src/config.js';
import { createApp } from '../src/server.js';
import { publish } from '../src/cli/client.js';

const OUT = new URL('../docs/images/', import.meta.url).pathname;
const OWNER = { 'tailscale-user-login': 'alex@example.com', 'tailscale-user-name': 'Alex' };

const dir = await mkdtemp(join(tmpdir(), 'ta-screens-'));
const app = await createApp(normalize({ ...DEFAULTS, dataDir: dir, port: 0, owners: ['alex@example.com'] }), { log: () => {} });
const token = app.tokens.create('dev-box');
const { port } = await app.listen();
const base = `http://127.0.0.1:${port}`;
const pub = (files, options) => publish({ url: base, token, files, options });
const f = (path, s) => ({ path, data: Buffer.from(s) });
const browser = await chromium.launch();

const checkout = (cta, note) => f('index.html', `<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{margin:0;font:16px/1.5 system-ui;background:#f5f3ff;color:#1e1b4b}main{padding:28px 22px;max-width:440px;margin:0 auto}
h1{font-size:26px;margin:0 0 4px}p{color:#6b6b8a;margin:0 0 22px}.card{background:#fff;border-radius:14px;padding:16px;box-shadow:0 1px 3px #0001;margin-bottom:14px}
.row{display:flex;justify-content:space-between;margin:6px 0}.tot{font-weight:700;border-top:1px solid #eee;padding-top:10px;margin-top:10px}
.saved{display:flex;gap:10px;align-items:center}.chip{width:38px;height:26px;border-radius:5px;background:linear-gradient(135deg,#6366f1,#a855f7)}
button{width:100%;background:#4f46e5;color:#fff;border:0;border-radius:12px;padding:15px;font-size:17px;font-weight:600}small{display:block;text-align:center;color:#8b8ba7;margin-top:10px}</style></head>
<body><main><h1>Checkout</h1><p>${note}</p>
<div class=card><div class=row><span>Wireless headphones</span><span>$129.00</span></div><div class=row><span>Shipping</span><span>Free</span></div><div class="row tot"><span>Total</span><span>$129.00</span></div></div>
<div class="card saved"><span class=chip></span><span>Visa •••• 4242<br><small style="text-align:left;margin:0">Expires 08/29</small></span></div>
<button>${cta}</button><small>Secure payment · cancel anytime</small></main></body></html>`);

// Demo content, oldest first.
await pub([f('report.md', '# Weekly latency\n\n| Endpoint | p50 | p95 |\n|---|---|---|\n| /api/search | 42 ms | 180 ms |\n| /api/checkout | 88 ms | 310 ms |\n\n- p95 regression on checkout after #412\n')], { name: 'Latency report', by: 'ci/github-actions', ttl: '20h' });
const shot = await browser.newPage({ viewport: { width: 390, height: 640 } });
await shot.setContent('<body style="margin:0;font:16px system-ui;background:linear-gradient(160deg,#0ea5e9,#6366f1);color:#fff;height:640px;display:grid;place-items:center;text-align:center"><div><div style="font-size:64px">👋</div><h1 style="margin:8px 0">Welcome aboard</h1><p style="opacity:.85">Let\'s set up your workspace</p><div style="margin-top:28px;background:#fff;color:#4338ca;border-radius:12px;padding:14px 40px;font-weight:600">Get started</div></div></body>');
await pub([{ path: 'onboarding.png', data: await shot.screenshot() }], { name: 'Onboarding — mobile', by: 'claude' });
await shot.close();
await pub([f('migrate-dry-run.log', 'checking 14 tables...\nusers: ok\norders: 2 columns renamed\n')], { name: 'Migration dry run', by: 'codex' });
await pub([checkout('Start free trial', 'Simple plans for teams.')], { name: 'Pricing page', by: 'claude', keep: true });
const c = await pub([checkout('Pay $129.00', 'Two-step flow')], { name: 'Checkout redesign', by: 'codex', note: 'first cut' });
await pub([checkout('Pay $129.00', 'Single page, saved cards')], { to: c.id, by: 'claude', note: 'single page variant' });

async function capture({ width, height, scale }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: 'light', extraHTTPHeaders: OWNER });
  // Apple share icon in all images, matching the phones.
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }));
  const gallery = await ctx.newPage();
  await gallery.goto(`${base}/`);
  await gallery.waitForTimeout(300);
  const galleryPng = await gallery.screenshot();
  const viewer = await ctx.newPage();
  await viewer.goto(`${base}/a/${c.id}/`);
  await viewer.frameLocator('#frame').locator('button').waitFor();
  return { ctx, galleryPng, viewer };
}

// Phones: gallery + viewer showing a live update.
const phone = await capture({ width: 390, height: 844, scale: 2 });
await pub([checkout('Pay now — $129.00', 'Single page, saved cards')], { to: c.id, by: 'codex', note: 'clearer CTA' });
await phone.viewer.locator('#toast', { hasText: 'Updated to v3' }).waitFor();
await phone.viewer.frameLocator('#frame').locator('button', { hasText: 'Pay now' }).waitFor();
const phoneViewerPng = await phone.viewer.screenshot();
await phone.ctx.close();

// Desktop: refresh the gallery (v3 now), and the viewer.
const desk = await capture({ width: 1280, height: 600, scale: 2 });
const deskViewerPng = await desk.viewer.screenshot();
await desk.ctx.close();

const b64 = (b) => `data:image/png;base64,${b.toString('base64')}`;
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

async function frame(html, out) {
  await page.setContent(`<body style="margin:0;background:#eef0f4;font:600 17px system-ui;color:#3f3f46">${html}</body>`);
  await page.waitForTimeout(200);
  await writeFile(join(OUT, out), await page.locator('body > div').screenshot());
}

await frame(`<div style="display:inline-flex;gap:56px;justify-content:center;padding:36px 40px 30px">
${[[phone.galleryPng, 'Gallery — every artifact, version and expiry'], [phoneViewerPng, 'Viewer — updates live when an agent publishes']].map(([img, cap]) => `
<figure style="margin:0;text-align:center"><img src="${b64(img)}" style="width:360px;border-radius:28px;border:9px solid #18181b;box-shadow:0 18px 40px #0003;display:block">
<figcaption style="margin-top:16px">${cap}</figcaption></figure>`).join('')}</div>`, 'overview.png');

const windowFrame = (img, title) => `<div style="padding:32px 40px;display:inline-block">
<div style="width:1100px;border-radius:12px;overflow:hidden;box-shadow:0 18px 50px #0003;border:1px solid #d4d4d8;background:#fff">
<div style="height:34px;background:#e4e4e7;display:flex;align-items:center;gap:8px;padding:0 14px">
<span style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></span><span style="width:12px;height:12px;border-radius:50%;background:#febc2e"></span><span style="width:12px;height:12px;border-radius:50%;background:#28c840"></span>
<span style="flex:1;text-align:center;font:500 13px system-ui;color:#52525b">${title}</span><span style="width:52px"></span></div>
<img src="${b64(img)}" style="width:1100px;display:block"></div></div>`;
await frame(windowFrame(desk.galleryPng, 'artifacts.example.ts.net'), 'desktop-gallery.png');
await frame(windowFrame(deskViewerPng, 'artifacts.example.ts.net/a/checkout-redesign/'), 'desktop-viewer.png');

await browser.close();
await app.close();
await rm(dir, { recursive: true, force: true });
console.log('wrote overview.png, desktop-gallery.png, desktop-viewer.png to', OUT);
