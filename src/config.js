// Server configuration: defaults < config file < environment variables.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDuration, parseSize } from './util.js';

export const DEFAULTS = Object.freeze({
  dataDir: './data',
  host: '127.0.0.1',
  port: 8790,
  // Absolute base URL used in links returned to clients, e.g. https://artifacts.example.ts.net
  // When empty, it is derived from the request (Host / X-Forwarded-* headers).
  publicUrl: '',
  // Optional separate origin for untrusted artifact content (future: per-version hosts).
  // When empty, content is served from publicUrl and isolated with the CSP sandbox header.
  contentOrigin: '',
  defaultTtl: '7d',
  maxTtl: '365d',
  tombstoneTtl: '30d',
  maxPublishSize: '50MB',
  maxFiles: 2000,
  maxDataSize: '8GB',
  gcInterval: '1h',
  // Identity adapter: "tailscale" (Tailscale-User-* headers from `tailscale serve`) or "none".
  identity: 'tailscale',
  // Logins allowed to pin/extend/delete from the browser. Empty = nobody (token holders still can).
  owners: [],
  // File with publish tokens, one per line: "<name> sha256:<hex>". Defaults to <dataDir>/tokens.
  tokensFile: '',
});

const ENV = {
  ARTIFACTS_DATA_DIR: 'dataDir',
  ARTIFACTS_HOST: 'host',
  ARTIFACTS_PORT: 'port',
  ARTIFACTS_PUBLIC_URL: 'publicUrl',
  ARTIFACTS_CONTENT_ORIGIN: 'contentOrigin',
  ARTIFACTS_DEFAULT_TTL: 'defaultTtl',
  ARTIFACTS_MAX_TTL: 'maxTtl',
  ARTIFACTS_TOMBSTONE_TTL: 'tombstoneTtl',
  ARTIFACTS_MAX_PUBLISH_SIZE: 'maxPublishSize',
  ARTIFACTS_MAX_FILES: 'maxFiles',
  ARTIFACTS_MAX_DATA_SIZE: 'maxDataSize',
  ARTIFACTS_GC_INTERVAL: 'gcInterval',
  ARTIFACTS_IDENTITY: 'identity',
  ARTIFACTS_OWNERS: 'owners',
  ARTIFACTS_TOKENS_FILE: 'tokensFile',
};

export function loadConfig({ file, env = process.env, overrides = {} } = {}) {
  let raw = { ...DEFAULTS };
  const path = file ?? env.ARTIFACTS_CONFIG;
  if (path) raw = { ...raw, ...JSON.parse(readFileSync(path, 'utf8')) };
  for (const [k, key] of Object.entries(ENV)) {
    if (env[k] !== undefined && env[k] !== '') raw[key] = env[k];
  }
  raw = { ...raw, ...overrides };
  return normalize(raw);
}

export function normalize(raw) {
  const owners = Array.isArray(raw.owners)
    ? raw.owners
    : String(raw.owners || '').split(',');
  const dataDir = resolve(raw.dataDir);
  const cfg = {
    dataDir,
    host: raw.host,
    port: Number(raw.port),
    publicUrl: stripSlash(raw.publicUrl || ''),
    contentOrigin: stripSlash(raw.contentOrigin || ''),
    defaultTtlMs: parseDuration(raw.defaultTtl),
    maxTtlMs: parseDuration(raw.maxTtl),
    tombstoneTtlMs: parseDuration(raw.tombstoneTtl),
    maxPublishBytes: parseSize(raw.maxPublishSize),
    maxFiles: Number(raw.maxFiles),
    maxDataBytes: parseSize(raw.maxDataSize),
    gcIntervalMs: parseDuration(raw.gcInterval),
    identity: raw.identity,
    owners: owners.map((s) => s.trim().toLowerCase()).filter(Boolean),
    tokensFile: raw.tokensFile ? resolve(raw.tokensFile) : resolve(dataDir, 'tokens'),
  };
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) throw new Error(`invalid port: ${raw.port}`);
  if (!['tailscale', 'none'].includes(cfg.identity)) throw new Error(`unknown identity adapter: ${cfg.identity}`);
  return cfg;
}

function stripSlash(s) {
  return s.replace(/\/+$/, '');
}
