import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, DEFAULTS } from '../src/config.js';
import { createApp } from '../src/server.js';

export async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ta-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function testConfig(dataDir, overrides = {}) {
  return normalize({ ...DEFAULTS, dataDir, port: 0, owners: ['owner@example.com'], ...overrides });
}

export class Clock {
  constructor(t = Date.UTC(2026, 0, 1)) { this.t = t; }
  now = () => this.t;
  advance(ms) { this.t += ms; }
}

/** Start a real server on an ephemeral port. */
export async function startServer(overrides = {}) {
  const tmp = await tempDir();
  const clock = new Clock(Date.now());
  const cfg = testConfig(tmp.dir, overrides);
  const app = await createApp(cfg, { log: () => {}, now: clock.now });
  const token = app.tokens.create('test-publisher');
  const addr = await app.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    app, cfg, clock, token, base,
    async stop() {
      await app.close();
      await tmp.cleanup();
    },
  };
}

export const OWNER = { 'tailscale-user-login': 'owner@example.com', 'tailscale-user-name': 'Owner' };
export const STRANGER = { 'tailscale-user-login': 'guest@example.com', 'tailscale-user-name': 'Guest' };

export function file(path, content) {
  return { path, data: Buffer.from(content) };
}
