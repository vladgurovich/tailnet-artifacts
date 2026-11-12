import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
const STATIC_FILES = new Set(['app.css', 'app.js', 'shell.js', 'icon.svg']);
const ID_SEG = '([a-z0-9][a-z0-9-]{0,48})';

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

  const trustedCsp = () => {
    const extra = cfg.contentOrigin ? ` ${cfg.contentOrigin}` : '';
    return `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:${extra}; `
      + `frame-src 'self'${extra}; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
  };

  function send(res, status, body, headers = {}) {
    res.writeHead(status, headers);
    res.end(body);
  }

  function sendPage(res, status, html) {
    send(res, status, html, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': trustedCsp(),
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

  function contentHeaders(type, { sandbox = true, size } = {}) {
    const ancestors = cfg.contentOrigin ? (cfg.publicUrl || "'self'") : "'self'";
    const h = {
      'Content-Type': type,
      'Content-Security-Policy': `${sandbox ? `${SANDBOX}; ` : ''}frame-ancestors ${ancestors}`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Sandboxed pages have an opaque ("null") origin; module scripts and fonts need CORS to load.
      'Access-Control-Allow-Origin': 'null',
      'Cache-Control': 'private, max-age=300',
    };
    if (size != null) h['Content-Length'] = String(size);
    return h;
  }

  // ---- auth -----------------------------------------------------------------

  function viewer(req) {
    return identity.identify(req);
  }

  function bearer(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    return m ? tokens.verify(m[1]) : null;
  }

  /** Token holders, or configured owners acting from this app's own pages (CSRF-protected). */
  function requireManager(req) {
    const tokenName = bearer(req);
    if (tokenName) return { token: tokenName, login: null };
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
    const tokenName = bearer(req);
    if (!tokenName) throw new HttpError(401, 'unauthorized', 'a valid publish token is required');
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    if (type !== BUNDLE_TYPE) throw new HttpError(415, 'unsupported_type', `expected ${BUNDLE_TYPE}`);
    const body = await readBody(req, cfg.maxPublishBytes + 1024 * 1024);
    const { files, options } = decodeBundle(body);
    let ttlMs;
    if (options.ttl != null) {
      try { ttlMs = parseDuration(options.ttl); } catch (e) { throw new HttpError(400, 'bad_ttl', e.message); }
    }
    const who = viewer(req);
    const { meta, version } = await store.publish(files, {
      name: options.name,
      to: toId,
      expectedVersion: options.expectedVersion,
      ttlMs,
      keep: options.keep === true,
      note: options.note,
      by: options.by,
      entry: options.entry,
      publisher: { token: tokenName, login: who?.login ?? null },
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

  async function serveContent(req, res, id, n, rest) {
    const found = store.lookup(id);
    if (found.state === 'gone') return sendPage(res, 410, pages.gonePage(found.tombstone));
    if (found.state === 'missing') return sendPage(res, 404, pages.notFoundPage());
    const meta = found.meta;
    const version = meta.versions.find((v) => v.n === n);
    if (!version) return sendPage(res, 404, pages.notFoundPage());

    let rel;
    try {
      rel = rest.split('/').map(decodeURIComponent).join('/');
    } catch {
      return sendPage(res, 400, pages.notFoundPage());
    }

    // Version root of a single-file artifact gets a small viewer page.
    if (rel === '' && ['image', 'markdown', 'file'].includes(version.kind)) {
      let html;
      if (version.kind === 'image') html = pages.imageContent(meta.name, version.entry);
      else if (version.kind === 'file') html = pages.fileContent(meta.name, version.entry, version.size);
      else {
        const f = await store.resolveFile(id, n, version.entry);
        html = pages.markdownContent(meta.name, await readFile(f.path, 'utf8'));
      }
      const body = Buffer.from(html);
      res.writeHead(200, contentHeaders('text/html; charset=utf-8', { size: body.length }));
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    const file = await store.resolveFile(id, n, rel);
    if (!file) return sendPage(res, 404, pages.notFoundPage());
    const ext = extname(file.path).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    const headers = contentHeaders(type, { sandbox: ext !== '.pdf', size: file.size });
    if (version.kind === 'file' && rel !== '') headers['Content-Disposition'] = 'attachment';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    createReadStream(file.path).pipe(res);
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

    if (path === '/healthz') return sendJson(res, 200, { ok: true, artifacts: store.list().length });

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
        return send(res, 302, '', { Location: `/a/${m[1]}/v/${found.meta.current}/${m[2]}`, 'Cache-Control': 'no-store' });
      }
      if ((m = new RegExp(`^/a/${ID_SEG}/v/(\\d{1,6})$`).exec(path))) {
        return send(res, 301, '', { Location: `${path}/` });
      }
      if ((m = new RegExp(`^/a/${ID_SEG}/v/(\\d{1,6})/(.*)$`).exec(path))) {
        return serveContent(req, res, m[1], Number(m[2]), m[3]);
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
        requireManager(req);
        const body = await readJson(req);
        const meta = await store.setPinned(m[1], body.pinned !== false);
        return sendJson(res, 200, artifactJson(meta, urlsFor(req)));
      }
      if ((m = new RegExp(`^/api/artifacts/${ID_SEG}/extend$`).exec(path))) {
        requireManager(req);
        const body = await readJson(req);
        let ms;
        try { ms = parseDuration(body.ttl ?? '7d'); } catch (e) { throw new HttpError(400, 'bad_ttl', e.message); }
        const meta = await store.extend(m[1], ms);
        return sendJson(res, 200, artifactJson(meta, urlsFor(req)));
      }
    }

    if (method === 'DELETE' && (m = new RegExp(`^/api/artifacts/${ID_SEG}$`).exec(path))) {
      const actor = requireManager(req);
      const r = await store.remove(m[1], 'deleted');
      log('info', 'delete requested', { id: m[1], by: actor.token ?? actor.login });
      return sendJson(res, 200, { deleted: r.id });
    }

    throw new HttpError(404, 'not_found', 'no such route');
  }

  async function handler(req, res) {
    const started = Date.now();
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

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[process.env.ARTIFACTS_LOG_LEVEL || 'info'] ?? 20;

export function defaultLog(level, message, fields = {}) {
  if ((LEVELS[level] ?? 20) < MIN_LEVEL) return;
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, message, ...fields })}\n`);
}
