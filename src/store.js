// Filesystem-backed artifact store. Single process owns the data directory.
//
// <dataDir>/
//   artifacts/<id>/meta.json        artifact metadata (written atomically)
//   artifacts/<id>/v/<n>/...        immutable version files
//   tombstones/<id>.json            expired/deleted marker (kept for tombstoneTtl)
//   .staging/<rand>/                in-progress publishes
//   .trash/<rand>/                  in-progress deletions
import { EventEmitter } from 'node:events';
import { mkdir, readdir, readFile, rename, rm, writeFile, lstat } from 'node:fs/promises';
import { join, dirname, extname, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { slugify, randomSuffix, safeRelPath, cleanLabel, ID_RE } from './util.js';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
const HTML_EXT = new Set(['.html', '.htm']);
const MD_EXT = new Set(['.md', '.markdown']);

export function detectKind(files, entryHint) {
  if (files.length === 1 && !entryHint) {
    const p = files[0].path;
    const ext = extname(p).toLowerCase();
    if (HTML_EXT.has(ext)) return { kind: 'html', entry: p };
    if (IMAGE_EXT.has(ext)) return { kind: 'image', entry: p };
    if (ext === '.pdf') return { kind: 'pdf', entry: p };
    if (MD_EXT.has(ext)) return { kind: 'markdown', entry: p };
    return { kind: 'file', entry: p };
  }
  const paths = new Set(files.map((f) => f.path));
  if (entryHint) {
    const e = safeRelPath(entryHint);
    if (!e || !paths.has(e)) throw new HttpError(400, 'bad_entry', `entry "${entryHint}" is not among the uploaded files`);
    return { kind: 'site', entry: e };
  }
  if (paths.has('index.html')) return { kind: 'site', entry: 'index.html' };
  const htmls = [...paths].filter((p) => HTML_EXT.has(extname(p).toLowerCase()));
  if (htmls.length === 1) return { kind: 'site', entry: htmls[0] };
  throw new HttpError(400, 'no_entry', 'directory has no index.html; pass --entry <file>');
}

export class Store extends EventEmitter {
  constructor(cfg, { now = () => Date.now(), log = () => {} } = {}) {
    super();
    this.cfg = cfg;
    this.now = now;
    this.log = log;
    this.root = cfg.dataDir;
    this.dirs = {
      artifacts: join(this.root, 'artifacts'),
      tombstones: join(this.root, 'tombstones'),
      staging: join(this.root, '.staging'),
      trash: join(this.root, '.trash'),
    };
    this.metas = new Map();
    this.tombstones = new Map();
    this.locks = new Map();
  }

  async init() {
    for (const d of Object.values(this.dirs)) await mkdir(d, { recursive: true });
    await rm(this.dirs.staging, { recursive: true, force: true });
    await mkdir(this.dirs.staging, { recursive: true });
    await this.#emptyTrash();
    for (const id of await readdir(this.dirs.artifacts)) {
      const dir = join(this.dirs.artifacts, id);
      let meta;
      try {
        meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
      } catch {
        this.log('warn', 'removing artifact dir without readable meta', { id });
        await this.#trash(dir);
        continue;
      }
      // Remove version dirs left behind by a crash between rename and meta write.
      const known = new Set(meta.versions.map((v) => String(v.n)));
      for (const n of await readdir(join(dir, 'v')).catch(() => [])) {
        if (!known.has(n)) await this.#trash(join(dir, 'v', n));
      }
      this.metas.set(meta.id, meta);
    }
    for (const f of await readdir(this.dirs.tombstones)) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(await readFile(join(this.dirs.tombstones, f), 'utf8'));
        this.tombstones.set(t.id, t);
      } catch { /* ignore corrupt tombstone */ }
    }
    await this.#emptyTrash();
  }

  // ---- queries ------------------------------------------------------------

  isExpired(meta, now = this.now()) {
    return meta.expiresAt != null && now >= meta.expiresAt;
  }

  /** { state: 'live', meta } | { state: 'gone', tombstone } | { state: 'missing' } */
  lookup(id) {
    const meta = this.metas.get(id);
    if (meta && !this.isExpired(meta)) return { state: 'live', meta };
    if (meta) return { state: 'gone', tombstone: { id, name: meta.name, reason: 'expired', at: meta.expiresAt } };
    const t = this.tombstones.get(id);
    if (t) return { state: 'gone', tombstone: t };
    return { state: 'missing' };
  }

  list() {
    const now = this.now();
    return [...this.metas.values()]
      .filter((m) => !this.isExpired(m, now))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  totalBytes() {
    let n = 0;
    for (const m of this.metas.values()) for (const v of m.versions) n += v.size;
    return n;
  }

  /** Resolve a file inside a version. Returns { path, size } or null. Never follows symlinks. */
  async resolveFile(id, n, relPath) {
    const meta = this.metas.get(id);
    const version = meta?.versions.find((v) => v.n === n);
    if (!version) return null;
    const base = join(this.dirs.artifacts, id, 'v', String(n));
    let rel = relPath === '' ? version.entry : safeRelPath(relPath);
    if (!rel) return null;
    let full = join(base, rel);
    if (!full.startsWith(base + sep)) return null;
    let st = await lstat(full).catch(() => null);
    if (st?.isDirectory()) {
      rel = `${rel}/index.html`;
      full = join(full, 'index.html');
      st = await lstat(full).catch(() => null);
    }
    if (!st?.isFile()) return null;
    return { path: full, rel, size: st.size };
  }

  // ---- mutations ----------------------------------------------------------

  /**
   * files: [{ path, data: Buffer }]
   * opts:  { name, to, expectedVersion, ttlMs, keep, note, by, entry, publisher: { token, login } }
   */
  async publish(files, opts = {}) {
    this.#validateFiles(files);
    const incoming = files.reduce((s, f) => s + f.data.length, 0);
    if (this.totalBytes() + incoming > this.cfg.maxDataBytes) {
      throw new HttpError(507, 'storage_full', 'artifact storage is full; delete or let artifacts expire first');
    }
    const { kind, entry } = detectKind(files, opts.entry);
    const ttlMs = this.#ttl(opts.ttlMs);
    const now = this.now();

    let id = opts.to;
    if (id) {
      if (!ID_RE.test(id)) throw new HttpError(400, 'bad_id', `invalid artifact id: ${id}`);
      const found = this.lookup(id);
      if (found.state === 'gone') throw new HttpError(410, 'gone', `artifact ${id} has expired or was deleted; publish a new one`);
      if (found.state === 'missing') throw new HttpError(404, 'not_found', `artifact ${id} does not exist`);
    } else {
      id = this.#newId(opts.name);
    }

    return this.#withLock(id, async () => {
      const existing = this.metas.get(id);
      if (opts.to && (!existing || this.isExpired(existing))) {
        throw new HttpError(410, 'gone', `artifact ${id} has expired or was deleted; publish a new one`);
      }
      if (existing && opts.expectedVersion != null && Number(opts.expectedVersion) !== existing.current) {
        throw new HttpError(409, 'conflict', `artifact ${id} is at version ${existing.current}, not ${opts.expectedVersion}`, { current: existing.current });
      }
      const n = existing ? existing.current + 1 : 1;

      const stage = join(this.dirs.staging, randomBytes(8).toString('hex'));
      await mkdir(stage, { recursive: true });
      try {
        for (const f of files) {
          const dest = join(stage, f.path);
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, f.data, { flag: 'wx' });
        }
        const artDir = join(this.dirs.artifacts, id);
        await mkdir(join(artDir, 'v'), { recursive: true });
        await rename(stage, join(artDir, 'v', String(n)));
      } catch (e) {
        await rm(stage, { recursive: true, force: true });
        throw e;
      }

      const version = {
        n,
        createdAt: now,
        kind,
        entry,
        files: files.length,
        size: incoming,
        note: cleanLabel(opts.note, 500),
        by: cleanLabel(opts.by),
        publisher: {
          token: opts.publisher?.token ?? null,
          login: opts.publisher?.login ?? null,
        },
      };
      const meta = existing
        ? { ...existing, versions: [...existing.versions] }
        : {
          schema: 1,
          id,
          name: cleanLabel(opts.name, 120) || id,
          visibility: 'private',
          createdAt: now,
          pinned: false,
          versions: [],
        };
      if (existing && opts.name) meta.name = cleanLabel(opts.name, 120) || meta.name;
      meta.versions.push(version);
      meta.current = n;
      meta.updatedAt = now;
      if (opts.keep) meta.pinned = true;
      meta.ttlMs = ttlMs;
      meta.expiresAt = meta.pinned ? null : now + ttlMs;

      await this.#writeMeta(meta);
      this.log('info', 'published', { id, version: n, kind, files: files.length, size: incoming, by: version.by, token: version.publisher.token });
      this.emit('published', { id, version: n });
      return { meta, version };
    });
  }

  async setPinned(id, pinned) {
    return this.#mutateLive(id, (meta) => {
      meta.pinned = !!pinned;
      meta.expiresAt = meta.pinned ? null : this.now() + (meta.ttlMs ?? this.cfg.defaultTtlMs);
    });
  }

  async extend(id, ms) {
    const add = this.#ttl(ms);
    return this.#mutateLive(id, (meta) => {
      if (meta.pinned) return;
      const now = this.now();
      meta.expiresAt = Math.min(Math.max(meta.expiresAt ?? now, now) + add, now + this.cfg.maxTtlMs);
    });
  }

  async remove(id, reason = 'deleted') {
    return this.#withLock(id, async () => {
      const meta = this.metas.get(id);
      if (!meta) throw new HttpError(404, 'not_found', `artifact ${id} does not exist`);
      await this.#bury(meta, reason);
      return { id, name: meta.name };
    });
  }

  /** Delete expired artifacts and old tombstones. */
  async gc({ dryRun = false } = {}) {
    const now = this.now();
    const report = { deleted: [], purgedTombstones: 0, dryRun };
    for (const meta of [...this.metas.values()]) {
      if (!this.isExpired(meta, now)) continue;
      const size = meta.versions.reduce((s, v) => s + v.size, 0);
      if (dryRun) {
        report.deleted.push({ id: meta.id, name: meta.name, size });
        continue;
      }
      await this.#withLock(meta.id, async () => {
        const m = this.metas.get(meta.id);
        if (!m || !this.isExpired(m, this.now())) return;
        await this.#bury(m, 'expired');
        report.deleted.push({ id: m.id, name: m.name, size });
      });
    }
    for (const t of [...this.tombstones.values()]) {
      if (t.purgeAt <= now) {
        if (!dryRun) {
          await rm(join(this.dirs.tombstones, `${t.id}.json`), { force: true });
          this.tombstones.delete(t.id);
        }
        report.purgedTombstones++;
      }
    }
    if (!dryRun) await this.#emptyTrash();
    return report;
  }

  // ---- internals ----------------------------------------------------------

  #validateFiles(files) {
    if (!Array.isArray(files) || files.length === 0) throw new HttpError(400, 'empty', 'nothing to publish');
    if (files.length > this.cfg.maxFiles) throw new HttpError(413, 'too_many_files', `too many files (${files.length} > ${this.cfg.maxFiles})`);
    const seen = new Set();
    let total = 0;
    for (const f of files) {
      const p = safeRelPath(f.path);
      if (!p) throw new HttpError(400, 'bad_path', `unsafe file path: ${JSON.stringify(f.path)}`);
      const lower = p.toLowerCase();
      if (seen.has(lower)) throw new HttpError(400, 'duplicate_path', `duplicate file path: ${p}`);
      // A file and a directory with the same name cannot coexist.
      for (const s of seen) {
        if (s.startsWith(`${lower}/`) || lower.startsWith(`${s}/`)) throw new HttpError(400, 'path_conflict', `path conflicts with another file: ${p}`);
      }
      seen.add(lower);
      f.path = p;
      total += f.data.length;
    }
    if (total > this.cfg.maxPublishBytes) {
      throw new HttpError(413, 'too_large', `publish is ${total} bytes; limit is ${this.cfg.maxPublishBytes}`);
    }
  }

  #ttl(ms) {
    if (ms == null) return this.cfg.defaultTtlMs;
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, 'bad_ttl', 'ttl must be positive');
    if (n > this.cfg.maxTtlMs) throw new HttpError(400, 'bad_ttl', `ttl exceeds the maximum of ${this.cfg.maxTtlMs} ms; use keep instead`);
    return n;
  }

  #newId(name) {
    const base = slugify(name);
    for (let i = 0; i < 20; i++) {
      const id = `${base}-${randomSuffix(4)}`;
      if (!this.metas.has(id) && !this.tombstones.has(id)) return id;
    }
    throw new HttpError(500, 'id_exhausted', 'could not allocate an artifact id');
  }

  async #mutateLive(id, fn) {
    return this.#withLock(id, async () => {
      const found = this.lookup(id);
      if (found.state === 'gone') throw new HttpError(410, 'gone', `artifact ${id} has expired or was deleted`);
      if (found.state === 'missing') throw new HttpError(404, 'not_found', `artifact ${id} does not exist`);
      const meta = { ...found.meta };
      fn(meta);
      await this.#writeMeta(meta);
      return meta;
    });
  }

  async #writeMeta(meta) {
    const file = join(this.dirs.artifacts, meta.id, 'meta.json');
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(meta, null, 2));
    await rename(tmp, file);
    this.metas.set(meta.id, meta);
  }

  async #bury(meta, reason) {
    const now = this.now();
    const t = { id: meta.id, name: meta.name, reason, at: reason === 'expired' ? meta.expiresAt : now, purgeAt: now + this.cfg.tombstoneTtlMs };
    await writeFile(join(this.dirs.tombstones, `${meta.id}.json`), JSON.stringify(t));
    this.tombstones.set(meta.id, t);
    this.metas.delete(meta.id);
    await this.#trash(join(this.dirs.artifacts, meta.id));
    const size = meta.versions.reduce((s, v) => s + v.size, 0);
    this.log('info', reason === 'expired' ? 'expired' : 'deleted', { id: meta.id, name: meta.name, size, versions: meta.versions.length });
    this.emit('removed', { id: meta.id, reason });
  }

  async #trash(path) {
    const dest = join(this.dirs.trash, randomBytes(8).toString('hex'));
    await rename(path, dest).catch(async () => rm(path, { recursive: true, force: true }));
  }

  async #emptyTrash() {
    for (const e of await readdir(this.dirs.trash).catch(() => [])) {
      await rm(join(this.dirs.trash, e), { recursive: true, force: true });
    }
  }

  async #withLock(id, fn) {
    const prev = this.locks.get(id) ?? Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    const chain = prev.then(() => next);
    this.locks.set(id, chain);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === chain) this.locks.delete(id);
    }
  }
}
