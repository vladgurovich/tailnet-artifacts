import { createServer } from 'node:http';
import { constants as FS } from 'node:fs';
import { readFile, open } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, HttpError } from './store.js';
import { TokenStore } from './tokens.js';
import { getIdentityAdapter } from './identity.js';
import { makeUrls } from './urls.js';
import { decodeBundle, BUNDLE_TYPE } from './wire.js';
import { parseDuration } from './util.js';
import * as pages from './render.js';

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'static');
export const VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const STATIC_FILES = new Set(['app.css', 'app.js', 'shell.js', 'share.js', 'icon.svg']);
const ID_SEG = '([a-z0-9][a-z0-9-]{0,62})';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

// Untrusted content runs in a unique opaque origin: no access to this app's
// cookies, storage or authenticated APIs, and it cannot navigate the top window.
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

export async function createApp(cfg, { log = defaultLog, now } = {}) {
  const store = new Store(cfg, { log, now });
  await store.init();
  const tokens = new TokenStore(cfg.tokensFile);
  const identity = getIdentityAdapter(cfg.identity);
  const urlsFor = makeUrls(cfg);
  const subscribers = new Map(); // id -> Set<res>

  const fanout = (event) => (data) => {
    for (const res of subscribers.get(data.id) ?? []) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  store.on('published', fanout('published'));
  store.on('removed', fanout('removed'));

  // Scripts on trusted pages are allowed by per-response nonce, not 'self': uploaded
  // artifacts share this origin, so 'self' would also allow any uploaded .js file.
  const trustedCsp = (nonce) => {
    const extra = cfg.contentOrigin ? ` ${cfg.contentOrigin}` : '';
    return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self'; img-src 'self' data:${extra}; `
      + `frame-src 'self'${extra}; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
  };

  function send(res, status, body, headers = {}) {
    res.writeHead(status, headers);
    res.end(body);
  }

  function sendPage(res, status, html) {
    const nonce = randomBytes(16).toString('base64');
    send(res, status, html.replaceAll(pages.NONCE_PLACEHOLDER, nonce), {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': trustedCsp(nonce),
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
  }

  function sendJson(res, status, obj) {
    send(res, status, JSON.stringify(obj, null, 2) + '\n', {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
  }

  /**
   * Headers for everything under /a/<id>/v/<n>/ — including errors, so responses look
   * the same to a sandboxed page whether or not an artifact exists.
   */
  function contentHeaders(type, { sandbox = true, scripts = true, size } = {}) {
    const ancestors = cfg.contentOrigin ? (cfg.publicUrl || "'self'") : "'self'";
    const csp = [sandbox ? SANDBOX : null, scripts ? null : "script-src 'none'", `frame-ancestors ${ancestors}`];
    const h = {
      'Content-Type': type,
      'Content-Security-Policy': csp.filter(Boolean).join('; '),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Sandboxed pages have an opaque ("null") origin; module scripts and fonts need CORS to load.
      'Access-Control-Allow-Origin': 'null',
      // Revalidate every time (ETag makes that cheap) so expired or deleted content is not served from cache.
      'Cache-Control': 'private, no-cache',
    };
    if (size != null) h['Content-Length'] = String(size);
    return h;
  }

  function sendContentPage(res, status, html, opts = {}) {
    const body = Buffer.from(html);
    res.writeHead(status, contentHeaders('text/html; charset=utf-8', { scripts: false, size: body.length, ...opts }));
    res.end(body);
  }

  // ---- auth -----------------------------------------------------------------

  function viewer(req) {
    return identity.identify(req);
  }

  /** { name, scope } for a valid bearer token, else null. */
  function bearer(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    return m ? tokens.verify(m[1]) : null;
  }

  /** The token that created an artifact (older artifacts: the first version's token). */
  function creatorToken(meta) {
    return meta.createdBy?.token ?? meta.versions[0]?.publisher?.token ?? null;
  }

  /** publish-scoped tokens may only change artifacts they created; admin tokens may change any. */
  function assertTokenMayChange(tok, id) {
    if (tok.scope === 'admin') return;
    const found = store.lookup(id);
    if (found.state !== 'live') return; // the store reports 404/410 with a clearer message
    const creator = creatorToken(found.meta);
    if (creator !== tok.name) {
      throw new HttpError(403, 'forbidden', `token "${tok.name}" has publish scope and can only change artifacts it created (${id} was created by ${creator ? `"${creator}"` : 'another publisher'})`);
    }
  }

  /** Token holders (within their scope), or configured owners acting from this app's own pages (CSRF-protected). */
  function requireManager(req, id) {
    const tok = bearer(req);
    if (tok) {
      assertTokenMayChange(tok, id);
      return { token: tok.name, login: null };
    }
    const who = viewer(req);
    if (!who) throw new HttpError(401, 'unauthorized', 'a publish token or owner login is required');
    if (!cfg.owners.includes(who.login)) throw new HttpError(403, 'forbidden', `${who.login} is not an owner`);
    // A custom header cannot be sent cross-origin without a CORS preflight, which this server never approves.
    const site = req.headers['sec-fetch-site'];
    if (req.headers['x-artifacts-csrf'] !== '1' || (site && site !== 'same-origin')) {
      throw new HttpError(403, 'csrf', 'cross-site request rejected');
    }
    return { token: null, login: who.login };
  }

  function canManage(req) {
    const who = viewer(req);
    return !!who && cfg.owners.includes(who.login);
  }

  // ---- request body ---------------------------------------------------------

  async function readBody(req, limit) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      throw new HttpError(413, 'too_large', `request is ${declared} bytes; limit is ${limit}`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'too_large', `request exceeds ${limit} bytes`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }

  async function readJson(req) {
    const buf = await readBody(req, 64 * 1024);
    if (!buf.length) return {};
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw new HttpError(400, 'bad_json', 'request body is not valid JSON');
    }
  }

  // ---- serialization --------------------------------------------------------

  function artifactJson(meta, urls) {
    return {
      id: meta.id,
      name: meta.name,
      visibility: meta.visibility,
      current: meta.current,
      createdAt: iso(meta.createdAt),
      updatedAt: iso(meta.updatedAt),
      expiresAt: iso(meta.expiresAt),
      pinned: meta.pinned,
      createdBy: { token: creatorToken(meta) },
      links: { latest: urls.artifact(meta.id), info: urls.info(meta.id) },
      versions: meta.versions.map((v) => ({
        n: v.n,
        kind: v.kind,
        entry: v.entry,
        files: v.files,
        size: v.size,
        note: v.note,
        by: v.by,
        publisher: v.publisher,
        createdAt: iso(v.createdAt),
        links: { view: urls.viewVersion(meta.id, v.n), raw: urls.version(meta.id, v.n) },
      })),
    };
  }

  // ---- handlers -------------------------------------------------------------

  async function publish(req, res, toId) {
    const tok = bearer(req);
    if (!tok) throw new HttpError(401, 'unauthorized', 'a valid publish token is required');
    if (toId) assertTokenMayChange(tok, toId);
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    if (type !== BUNDLE_TYPE) throw new HttpError(415, 'unsupported_type', `expected ${BUNDLE_TYPE}`);
    const body = await readBody(req, cfg.maxPublishBytes + 1024 * 1024);
    const { files, options } = decodeBundle(body);
    let ttlMs;
    if (options.ttl != null) {
      try { ttlMs = parseDuration(options.ttl); } catch (e) { throw new HttpError(400, 'bad_ttl', e.message); }
    }
    const who = viewer(req);
    const { meta, version, warnings } = await store.publish(files, {
      name: options.name,
      to: toId,
      expectedVersion: options.expectedVersion,
      ttlMs,
      keep: options.keep === true,
      note: options.note,
      by: options.by,
      entry: options.entry,
      publisher: { token: tok.name, login: who?.login ?? null },
    });
    const urls = urlsFor(req);
    sendJson(res, toId ? 200 : 201, {
      id: meta.id,
      name: meta.name,
      version: version.n,
      kind: version.kind,
      expiresAt: iso(meta.expiresAt),
      links: {
        latest: urls.artifact(meta.id),
        version: urls.viewVersion(meta.id, version.n),
        raw: urls.version(meta.id, version.n),
        info: urls.info(meta.id),
      },
      warnings,
    });
  }

  function events(req, res, id) {
    const found = store.lookup(id);
    if (found.state !== 'live') throw new HttpError(found.state === 'gone' ? 410 : 404, found.state, 'artifact not available');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ id, version: found.meta.current })}\n\n`);
    let set = subscribers.get(id);
    if (!set) subscribers.set(id, (set = new Set()));
    set.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      set.delete(res);
      if (!set.size) subscribers.delete(id);
    });
  }

  const viewerCache = new Map(); // `${id}/${n}` -> rendered wrapper HTML (versions are immutable)
  async function viewerPage(meta, version) {
    const key = `${meta.id}/${version.n}`;
    if (viewerCache.has(key)) return viewerCache.get(key);
    let html;
    if (version.kind === 'image') html = pages.imageContent(meta.name, version.entry);
    else if (version.kind === 'file') html = pages.fileContent(meta.name, version.entry, version.size);
    else {
      const f = await store.resolveFile(meta.id, version.n, version.entry);
      if (!f) return null;
      const fh = await open(f.path, FS.O_RDONLY | FS.O_NOFOLLOW).catch(() => null);
      if (!fh) return null;
      let text;
      try {
        const len = Math.min(f.size, TEXT_PREVIEW_BYTES);
        const { buffer, bytesRead } = await fh.read(Buffer.alloc(len), 0, len, 0);
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await fh.close();
      }
      html = version.kind === 'markdown'
        ? pages.markdownContent(meta.name, text)
        : pages.textContent(meta.name, version.entry, text, f.size > TEXT_PREVIEW_BYTES);
    }
    viewerCache.set(key, html);
    if (viewerCache.size > 100) viewerCache.delete(viewerCache.keys().next().value);
    return html;
  }

  async function serveContent(req, res, id, n, rest, search) {
    const found = store.lookup(id);
    if (found.state === 'gone') return sendContentPage(res, 410, pages.gonePage(found.tombstone));
    if (found.state === 'missing') return sendContentPage(res, 404, pages.notFoundPage());
    const meta = found.meta;
    const version = meta.versions.find((v) => v.n === n);
    if (!version) return sendContentPage(res, 404, pages.notFoundPage());
    const base = `/a/${id}/v/${n}/`;

    let rel;
    try {
      rel = rest.split('/').map(decodeURIComponent).join('/');
    } catch {
      return sendContentPage(res, 400, pages.notFoundPage());
    }
    const trailingSlash = rel.endsWith('/');
    if (trailingSlash) rel = rel.slice(0, -1);

    if (rel === '') {
      // Single-file artifacts get a small viewer page at the version root.
      if (['image', 'markdown', 'text', 'file'].includes(version.kind)) {
        const html = await viewerPage(meta, version);
        if (!html) return sendContentPage(res, 404, pages.notFoundPage());
        return sendContentPage(res, 200, html);
      }
      // An entry inside a sub-directory must be loaded from its own directory,
      // or its relative asset URLs resolve against the version root.
      if (version.entry.includes('/')) {
        return send(res, 302, '', { ...contentHeaders('text/plain'), Location: `${base}${encodePath(version.entry)}${search}` });
      }
    }

    const file = await store.resolveFile(id, n, rel);
    if (!file) return sendContentPage(res, 404, pages.notFoundPage());
    if (file.viaDir && !trailingSlash) {
      return send(res, 301, '', { ...contentHeaders('text/plain'), Location: `${base}${encodePath(rel)}/${search}` });
    }
    return streamFile(req, res, file, version, rel);
  }

  /** Stream a file with ETag and single-range support. Never crashes on races or aborted clients. */
  async function streamFile(req, res, file, version, rel) {
    let fh;
    try {
      fh = await open(file.path, FS.O_RDONLY | FS.O_NOFOLLOW);
    } catch {
      // Deleted or expired between lookup and open.
      return sendContentPage(res, 404, pages.notFoundPage());
    }
    const ext = extname(file.path).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    const size = file.size;
    const etag = `"${version.n}-${size.toString(36)}-${Math.floor(file.mtimeMs).toString(36)}"`;
    const headers = contentHeaders(type, { sandbox: ext !== '.pdf' });
    headers.ETag = etag;
    headers['Accept-Ranges'] = 'bytes';
    if (version.kind === 'file' && rel !== '') headers['Content-Disposition'] = 'attachment';

    if (req.headers['if-none-match'] === etag) {
      await fh.close();
      res.writeHead(304, headers);
      return res.end();
    }

    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range && size > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') { start = Math.max(0, size - Number(m[2])); }
        else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
        if (start > end || start >= size) {
          await fh.close();
          res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' });
          return res.end();
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      }
    }
    headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) {
      await fh.close();
      return res.end();
    }
    // pipeline destroys the file stream (closing the fd) when the client goes away.
    pipeline(fh.createReadStream({ start, end, autoClose: true }), res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') log('warn', 'stream error', { path: file.rel, error: err.message });
    });
  }

  async function serveStatic(res, name) {
    if (!STATIC_FILES.has(name)) return sendPage(res, 404, pages.notFoundPage());
    const body = await readFile(join(STATIC_DIR, name));
    send(res, 200, body, {
      'Content-Type': MIME[extname(name)],
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=300',
    });
  }

  // ---- router ---------------------------------------------------------------

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const method = req.method;
    let m;

    if (path === '/healthz') return sendJson(res, 200, { ok: true, version: VERSION, artifacts: store.list().length });

    if (method === 'GET' || method === 'HEAD') {
      if ((m = /^\/static\/([\w.-]+)$/.exec(path))) return serveStatic(res, m[1]);
      if (path === '/') {
        const urls = urlsFor(req);
        return sendPage(res, 200, pages.galleryPage({
          items: store.list(), urls, viewer: viewer(req), canManage: canManage(req),
          totalBytes: store.totalBytes(), maxBytes: cfg.maxDataBytes, now: Date.now(),
        }));
      }
      if ((m = new RegExp(`^/a/${ID_SEG}$`).exec(path))) {
        return send(res, 301, '', { Location: `/a/${m[1]}/${url.search}` });
      }
      if ((m = new RegExp(`^/a/${ID_SEG}/$`).exec(path))) {
        const found = store.lookup(m[1]);
        if (found.state === 'gone') return sendPage(res, 410, pages.gonePage(found.tombstone));
        if (found.state === 'missing') return sendPage(res, 404, pages.notFoundPage());
        const meta = found.meta;
        const asked = Number(url.searchParams.get('v'));
        const n = meta.versions.some((v) => v.n === asked) ? asked : meta.current;
        return sendPage(res, 200, pages.shellPage({ meta, n, follow: n === meta.current, urls: urlsFor(req), canManage: canManage(req) }));
      }
      if ((m = new RegExp(`^/a/${ID_SEG}/info$`).exec(path))) {
        const found = store.lookup(m[1]);
        if (found.state === 'gone') return sendPage(res, 410, pages.gonePage(found.tombstone));
        if (found.state === 'missing') return sendPage(res, 404, pages.notFoundPage());
        return sendPage(res, 200, pages.infoPage({ meta: found.meta, urls: urlsFor(req), canManage: canManage(req), now: Date.now() }));
      }
      if ((m = new RegExp(`^/a/${ID_SEG}/latest/(.*)$`).exec(path))) {
        const found = store.lookup(m[1]);
        if (found.state !== 'live') return sendPage(res, found.state === 'gone' ? 410 : 404, found.state === 'gone' ? pages.gonePage(found.tombstone) : pages.notFoundPage());
        return send(res, 302, '', { Location: `/a/${m[1]}/v/${found.meta.current}/${m[2]}${url.search}`, 'Cache-Control': 'no-store' });
      }
      if ((m = new RegExp(`^/a/${ID_SEG}/v/(\\d{1,6})$`).exec(path))) {
        return send(res, 301, '', { Location: `${path}/${url.search}` });
      }
      if ((m = new RegExp(`^/a/${ID_SEG}/v/(\\d{1,6})/(.*)$`).exec(path))) {
        return serveContent(req, res, m[1], Number(m[2]), m[3], url.search);
      }
      if (path === '/api/artifacts') {
        const urls = urlsFor(req);
        return sendJson(res, 200, { artifacts: store.list().map((a) => artifactJson(a, urls)) });
      }
      if (path === '/api/whoami') {
        return sendJson(res, 200, { viewer: viewer(req), token: bearer(req), canManage: canManage(req) });
      }
      if ((m = new RegExp(`^/api/artifacts/${ID_SEG}/events$`).exec(path))) return events(req, res, m[1]);
      if ((m = new RegExp(`^/api/artifacts/${ID_SEG}$`).exec(path))) {
        const found = store.lookup(m[1]);
        if (found.state === 'gone') throw new HttpError(410, 'gone', `artifact ${m[1]} has expired or was deleted`, { tombstone: found.tombstone });
        if (found.state === 'missing') throw new HttpError(404, 'not_found', `artifact ${m[1]} does not exist`);
        return sendJson(res, 200, artifactJson(found.meta, urlsFor(req)));
      }
    }

    if (method === 'POST') {
      if (path === '/api/artifacts') return publish(req, res, null);
      if ((m = new RegExp(`^/api/artifacts/${ID_SEG}/versions$`).exec(path))) return publish(req, res, m[1]);
      if ((m = new RegExp(`^/api/artifacts/${ID_SEG}/pin$`).exec(path))) {
        requireManager(req, m[1]);
        const body = await readJson(req);
        const meta = await store.setPinned(m[1], body.pinned !== false);
        return sendJson(res, 200, artifactJson(meta, urlsFor(req)));
      }
      if ((m = new RegExp(`^/api/artifacts/${ID_SEG}/extend$`).exec(path))) {
        requireManager(req, m[1]);
        const body = await readJson(req);
        let ms;
        try { ms = parseDuration(body.ttl ?? '7d'); } catch (e) { throw new HttpError(400, 'bad_ttl', e.message); }
        const meta = await store.extend(m[1], ms);
        return sendJson(res, 200, artifactJson(meta, urlsFor(req)));
      }
    }

    if (method === 'DELETE' && (m = new RegExp(`^/api/artifacts/${ID_SEG}$`).exec(path))) {
      const actor = requireManager(req, m[1]);
      const r = await store.remove(m[1], 'deleted');
      log('info', 'delete requested', { id: m[1], by: actor.token ?? actor.login });
      return sendJson(res, 200, { deleted: r.id });
    }

    throw new HttpError(404, 'not_found', 'no such route');
  }

  /** Reject requests addressed to unexpected hostnames (DNS rebinding, misrouted proxies). */
  function hostAllowed(req) {
    const host = (req.headers.host || '').toLowerCase();
    const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '');
    return LOOPBACK.has(name) || cfg.allowedHosts.has(name);
  }

  async function handler(req, res) {
    const started = Date.now();
    if (!hostAllowed(req)) {
      log('warn', 'rejected host', { host: req.headers.host, url: req.url });
      return sendJson(res, 421, {
        error: 'misdirected',
        message: 'unexpected Host header; set ARTIFACTS_PUBLIC_URL (or ARTIFACTS_ALLOWED_HOSTS) to the address clients use',
      });
    }
    if (req.url !== '/healthz' && !req.url.includes('/events')) {
      res.on('finish', () => log('debug', 'request', { method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - started }));
    }
    try {
      await route(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log('error', 'request failed', { method: req.method, url: req.url, error: e.stack || String(e) });
      if (!res.headersSent) {
        const wantsHtml = !req.url.startsWith('/api/') && (req.headers.accept || '').includes('text/html');
        if (wantsHtml && status === 404) sendPage(res, 404, pages.notFoundPage());
        else sendJson(res, status, { error: e.code ?? 'internal', message: status === 500 ? 'internal error' : e.message, ...(e.extra ?? {}) });
      } else {
        res.destroy();
      }
    }
  }

  const server = createServer(handler);
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 30 * 1000;

  let gcTimer = null;
  async function runGc() {
    try {
      const r = await store.gc();
      if (r.deleted.length || r.purgedTombstones) log('info', 'gc', { deleted: r.deleted.length, purgedTombstones: r.purgedTombstones });
    } catch (e) {
      log('error', 'gc failed', { error: e.stack || String(e) });
    }
  }

  return {
    server,
    store,
    tokens,
    async listen() {
      await runGc();
      gcTimer = setInterval(runGc, cfg.gcIntervalMs);
      gcTimer.unref();
      await new Promise((resolve) => server.listen(cfg.port, cfg.host, resolve));
      return server.address();
    },
    async close() {
      clearInterval(gcTimer);
      for (const set of subscribers.values()) for (const r of set) r.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[process.env.ARTIFACTS_LOG_LEVEL || 'info'] ?? 20;

export function defaultLog(level, message, fields = {}) {
  if ((LEVELS[level] ?? 20) < MIN_LEVEL) return;
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, message, ...fields })}\n`);
}
