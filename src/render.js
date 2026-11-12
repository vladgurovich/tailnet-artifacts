// Server-rendered pages. Trusted pages (gallery, shell, info) never embed
// artifact content directly; content is always loaded in a sandboxed iframe.
import { Marked } from 'marked';
import { escapeHtml as h, formatBytes } from './util.js';

const KIND_ICON = { html: '◧', site: '◨', image: '◩', pdf: '▤', markdown: '¶', text: '≡', file: '▢' };
const KIND_LABEL = { html: 'HTML', site: 'Site', image: 'Image', pdf: 'PDF', markdown: 'Markdown', text: 'Text', file: 'File' };

// Replaced per response with a fresh CSP nonce (see sendPage in server.js).
export const NONCE_PLACEHOLDER = '__TA_CSP_NONCE__';

function layout({ title, body, scripts = [], bodyClass = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="same-origin">
<title>${h(title)}</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
</head>
<body class="${h(bodyClass)}">
${body}
${scripts.map((s) => `<script nonce="${NONCE_PLACEHOLDER}" src="/static/${h(s)}" defer></script>`).join('\n')}
</body>
</html>`;
}

function time(ms, cls = '') {
  if (ms == null) return '';
  const iso = new Date(ms).toISOString();
  return `<time class="${cls}" datetime="${iso}" data-rel>${iso.slice(0, 16).replace('T', ' ')} UTC</time>`;
}

function expiryBadge(meta, now) {
  if (meta.pinned || meta.expiresAt == null) return '<span class="badge pinned" title="Never expires">Pinned</span>';
  const soon = meta.expiresAt - now < 24 * 3600e3;
  const iso = new Date(meta.expiresAt).toISOString();
  return `<span class="badge${soon ? ' soon' : ''}" title="Expires ${iso}">Expires <time datetime="${iso}" data-rel>${iso.slice(0, 10)}</time></span>`;
}

function sourceLine(v) {
  const bits = [];
  if (v.by) bits.push(h(v.by));
  if (v.publisher?.token) bits.push(h(v.publisher.token));
  else if (v.publisher?.login) bits.push(h(v.publisher.login));
  return bits.join(' · ');
}

// The two platform-standard share icons; CSS shows the one matching the device
// (app.js / shell.js set html.apple on Apple platforms).
const SHARE_ICONS = `<svg class="share-icon share-apple" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M8.5 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2.5"/></svg>`
  + `<svg class="share-icon share-other" viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/></svg>`;

/** Share button. data-url/data-title feed the Web Share API (or the copy fallback). */
function shareButton(url, title, { label = true, cls = '' } = {}) {
  return `<button type="button" class="share ${cls}" data-share-url="${h(url)}" data-share-title="${h(title)}" aria-label="Share" title="Share link">${SHARE_ICONS}${label ? '<span>Share</span>' : ''}</button>`;
}

function ownerButtons(meta) {
  return `<button type="button" data-action="${meta.pinned ? 'unpin' : 'pin'}">${meta.pinned ? 'Unpin' : 'Pin'}</button>
  ${meta.pinned ? '' : '<button type="button" data-action="extend">+7 days</button>'}
  <button type="button" class="danger" data-action="delete">Delete</button>`;
}

function ownerControls(meta, canManage) {
  if (!canManage) return '';
  return `<div class="actions" data-id="${h(meta.id)}">
  ${ownerButtons(meta)}
</div>`;
}

/** Gallery card actions: Share for everyone, owner buttons for owners. */
function cardActions(meta, canManage, shareUrl) {
  return `<div class="actions" data-id="${h(meta.id)}">
  ${shareButton(shareUrl, meta.name)}
  ${canManage ? ownerButtons(meta) : ''}
</div>`;
}

export function galleryPage({ items, urls, viewer, canManage, totalBytes, maxBytes, now }) {
  const cards = items.map((m) => {
    const v = m.versions[m.versions.length - 1];
    const thumb = v.kind === 'image'
      ? `<img loading="lazy" alt="" src="${h(urls.file(m.id, v.n, v.entry))}">`
      : `<span class="icon" aria-hidden="true">${KIND_ICON[v.kind] ?? '▢'}</span>`;
    return `<li class="card">
  <a class="thumb" href="${h(urls.artifact(m.id))}">${thumb}</a>
  <div class="meta">
    <a class="title" href="${h(urls.artifact(m.id))}">${h(m.name)}</a>
    <div class="sub"><span class="kind">${KIND_LABEL[v.kind] ?? v.kind}</span> · <a href="${h(urls.info(m.id))}">v${m.current}</a> · ${time(m.updatedAt)}${sourceLine(v) ? ` · ${sourceLine(v)}` : ''}</div>
    <div class="row">${expiryBadge(m, now)}${cardActions(m, canManage, urls.artifact(m.id))}</div>
  </div>
</li>`;
  }).join('\n');
  const pct = maxBytes ? Math.min(100, Math.round((totalBytes / maxBytes) * 100)) : 0;
  const body = `<header class="top">
  <h1>Artifacts</h1>
  <span class="who">${viewer ? h(viewer.name) : ''}</span>
</header>
<main>
${items.length ? `<ul class="grid">${cards}</ul>` : `<div class="empty"><p>No artifacts yet.</p><p class="hint">Publish one with <code>artifacts publish ./mockup.html --name "My mockup"</code></p></div>`}
</main>
<div id="toast" class="toast" role="status" hidden></div>
<footer class="foot">
  <span>${items.length} artifact${items.length === 1 ? '' : 's'}</span>
  <span class="usage" title="${pct}% of storage used"><meter min="0" max="100" low="70" high="90" optimum="0" value="${pct}"></meter>${formatBytes(totalBytes)} of ${formatBytes(maxBytes)}</span>
</footer>`;
  return layout({ title: 'Artifacts', body, scripts: ['app.js', 'share.js'] });
}

export function shellPage({ meta, n, follow, urls, canManage }) {
  const v = meta.versions.find((x) => x.n === n);
  const src = urls.version(meta.id, n);
  // PDFs cannot render inside sandboxed frames in Chromium; the PDF viewer is isolated on its own.
  const sandbox = v.kind === 'pdf' ? '' : ' sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"';
  const options = [...meta.versions].reverse().map((x) =>
    `<option value="${x.n}"${x.n === n ? ' selected' : ''}>v${x.n}${x.n === meta.current ? ' (latest)' : ''}</option>`).join('');
  const body = `<header class="bar" id="shell"
  data-id="${h(meta.id)}" data-current="${meta.current}" data-n="${n}" data-kind="${h(v.kind)}" data-follow="${follow ? '1' : '0'}"
  data-version-base="${h(urls.version(meta.id, 0).replace(/0\/$/, ''))}">
  <a class="back" href="/" title="All artifacts" aria-label="All artifacts">←</a>
  <span class="name" title="${h(meta.name)}">${h(meta.name)}</span>
  <select id="ver" aria-label="Version">${options}</select>
  <span class="live" id="live" hidden title="Following latest version">● live</span>
  ${shareButton(follow ? urls.artifact(meta.id) : urls.viewVersion(meta.id, n), meta.name, { label: false, cls: 'bar-share' })}
  <a class="link" href="${h(urls.info(meta.id))}" title="Versions and details">Info</a>
  <a class="link" href="${h(src)}" target="_blank" rel="noopener" title="Open without the toolbar">Open ↗</a>
</header>
<div id="toast" class="toast" hidden></div>
<iframe id="frame" title="${h(meta.name)}" src="${h(src)}"${sandbox} referrerpolicy="no-referrer"></iframe>`;
  return layout({ title: meta.name, body, scripts: ['shell.js', 'share.js'], bodyClass: 'shell' + (canManage ? ' manage' : '') });
}

export function infoPage({ meta, urls, canManage, now }) {
  const rows = [...meta.versions].reverse().map((v) => `<li>
  <div class="vh"><a href="${h(urls.viewVersion(meta.id, v.n))}">v${v.n}</a>${v.n === meta.current ? ' <span class="badge">latest</span>' : ''}
  <span class="kind">${KIND_LABEL[v.kind] ?? v.kind}</span> · ${formatBytes(v.size)} · ${v.files} file${v.files === 1 ? '' : 's'} · ${time(v.createdAt)}</div>
  ${sourceLine(v) ? `<div class="src">${sourceLine(v)}</div>` : ''}
  ${v.note ? `<p class="note">${h(v.note)}</p>` : ''}
  <div class="vl"><a href="${h(urls.version(meta.id, v.n))}" target="_blank" rel="noopener">Raw ↗</a></div>
</li>`).join('\n');
  const total = meta.versions.reduce((s, v) => s + v.size, 0);
  const body = `<header class="top">
  <a class="back" href="/" aria-label="All artifacts">←</a>
  <h1>${h(meta.name)}</h1>
</header>
<main class="info">
  <dl>
    <dt>ID</dt><dd><code>${h(meta.id)}</code></dd>
    <dt>Latest</dt><dd><a href="${h(urls.artifact(meta.id))}">${h(urls.artifact(meta.id))}</a></dd>
    <dt>Created</dt><dd>${time(meta.createdAt)}</dd>
    <dt>Expiry</dt><dd>${expiryBadge(meta, now)}</dd>
    <dt>Size</dt><dd>${formatBytes(total)} across ${meta.versions.length} version${meta.versions.length === 1 ? '' : 's'}</dd>
  </dl>
  ${ownerControls(meta, canManage)}
  <h2>Versions</h2>
  <ol class="versions">${rows}</ol>
</main>`;
  return layout({ title: `${meta.name} · versions`, body, scripts: ['app.js'] });
}

export function gonePage(t) {
  const when = t.at ? new Date(t.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'recently';
  const why = t.reason === 'expired' ? 'expired' : 'was deleted';
  const body = `<main class="message">
  <h1>Gone</h1>
  <p>“${h(t.name)}” ${why} on ${h(when)}.</p>
  <p><a href="/">All artifacts</a></p>
</main>`;
  return layout({ title: 'Artifact gone', body });
}

export function notFoundPage() {
  return layout({ title: 'Not found', body: '<main class="message"><h1>Not found</h1><p>There is no artifact at this address.</p><p><a href="/">All artifacts</a></p></main>' });
}

// ---- untrusted content wrappers (served sandboxed) -------------------------

const CONTENT_CSS = `:root{color-scheme:light dark}body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}`;

export function imageContent(name, entry) {
  const src = entry.split('/').map(encodeURIComponent).join('/');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(name)}</title><style>${CONTENT_CSS}
body{min-height:100vh;display:grid;place-items:center;background:#1113}
img{max-width:100%;max-height:100vh;object-fit:contain;display:block}
a{display:contents}</style></head>
<body><a href="${h(src)}" target="_blank" rel="noopener"><img src="${h(src)}" alt="${h(name)}"></a></body></html>`;
}

const marked = new Marked({ gfm: true });

export function markdownContent(name, text) {
  const html = marked.parse(text);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(name)}</title><style>${CONTENT_CSS}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 4rem}
pre{overflow:auto;padding:.75rem;border-radius:6px;background:#8881}
code{font:.9em ui-monospace,SFMono-Regular,Menlo,monospace}
img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #8884;padding:.3rem .6rem}
blockquote{margin:0;padding-left:1rem;border-left:3px solid #8886;color:#888}</style></head>
<body><main>${html}</main></body></html>`;
}

export function fileContent(name, entry, size) {
  const href = entry.split('/').map(encodeURIComponent).join('/');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(name)}</title><style>${CONTENT_CSS}body{display:grid;place-items:center;min-height:100vh;text-align:center}</style></head>
<body><div><p><strong>${h(entry)}</strong><br>${formatBytes(size)}</p><p><a href="${h(href)}" download>Download</a></p></div></body></html>`;
}

export function textContent(name, entry, text, truncated) {
  const href = entry.split('/').map(encodeURIComponent).join('/');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(name)}</title><style>${CONTENT_CSS}
header{position:sticky;top:0;display:flex;gap:1rem;justify-content:space-between;padding:.5rem 1rem;font-size:13px;background:Canvas;border-bottom:1px solid #8883}
pre{margin:0;padding:1rem;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}</style></head>
<body><header><strong>${h(entry)}</strong><a href="${h(href)}" target="_blank" rel="noopener">Raw</a></header>
<pre>${h(text)}</pre>${truncated ? `<p style="padding:0 1rem 2rem">Truncated — <a href="${h(href)}" target="_blank" rel="noopener">open the full file</a>.</p>` : ''}</body></html>`;
}
