#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createApp, defaultLog } from '../src/server.js';
import { Store } from '../src/store.js';
import { TokenStore } from '../src/tokens.js';
import { clientConfig, collectFiles, publish, screenshot, CliError } from '../src/cli/client.js';
import { formatBytes } from '../src/util.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `tailnet-artifacts ${pkg.version} — versioned artifact links for your tailnet

Publishing (client):
  artifacts publish <file|dir> [--name "Title"] [--to <id>] [--note "what changed"]
                               [--by <agent or source>] [--ttl 30d | --keep]
                               [--entry page.html] [--expected-version N] [--url-only]
                               [--include-hidden]
  artifacts screenshot <url>   [--name "Title"] [--to <id>] [--mobile] [--viewport 1280,800]
                               [--no-full-page] [--wait 1000] [publish options...]

  Client config: ARTIFACTS_URL, ARTIFACTS_TOKEN, ARTIFACTS_BY
                 or ~/.config/tailnet-artifacts/{config.json,token}

  Directories: dotfiles (.env, .npmrc, …) and node_modules are skipped unless
  --include-hidden. Built apps must use relative asset paths (Vite: --base ./).

  Output: JSON on stdout (warnings also on stderr). On failure: JSON error on
  stderr and exit code 2 usage, 3 auth, 4 conflict, 5 not found/expired,
  6 too large/storage full, 7 network, 1 other.

Server:
  tailnet-artifacts serve [--config file.json]
  tailnet-artifacts gc [--dry-run] [--config file.json]      (run while the server is stopped,
                                                              or rely on the server's hourly gc)
  tailnet-artifacts token create <name> | list | revoke <name> [--config file.json]

  Server config: see README (ARTIFACTS_DATA_DIR, ARTIFACTS_PUBLIC_URL, ARTIFACTS_OWNERS, ...)
`;

const PUBLISH_OPTS = {
  name: { type: 'string' },
  to: { type: 'string' },
  note: { type: 'string' },
  by: { type: 'string' },
  ttl: { type: 'string' },
  keep: { type: 'boolean' },
  entry: { type: 'string' },
  'expected-version': { type: 'string' },
  'url-only': { type: 'boolean' },
  'include-hidden': { type: 'boolean' },
};

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'publish': return cmdPublish(rest);
    case 'screenshot': return cmdScreenshot(rest);
    case 'serve': return cmdServe(rest);
    case 'gc': return cmdGc(rest);
    case 'token': return cmdToken(rest);
    case '--version': case '-v': case 'version':
      console.log(pkg.version); return;
    case undefined: case 'help': case '--help': case '-h':
      process.stdout.write(HELP); return;
    default:
      throw usage(`unknown command: ${cmd}`);
  }
}

function usage(msg) {
  return new CliError('usage', `${msg} (run "artifacts help" for usage)`, { exitCode: 2 });
}

function publishOptions(values) {
  if (values.ttl && values.keep) throw usage('use either --ttl or --keep, not both');
  const cc = clientConfig();
  return {
    name: values.name,
    to: values.to,
    note: values.note,
    by: values.by ?? cc.by,
    ttl: values.ttl,
    keep: values.keep,
    entry: values.entry,
    expectedVersion: parseExpected(values['expected-version']),
  };
}

function parseExpected(v) {
  if (v == null) return undefined;
  if (!/^[1-9]\d*$/.test(v)) throw usage(`--expected-version must be a positive integer, got "${v}"`);
  return Number(v);
}

function collectOptions(values) {
  return {
    includeHidden: values['include-hidden'],
    onSkip: (p) => { skipped.push(p); },
  };
}
const skipped = [];

function reportSkipped() {
  if (!skipped.length) return;
  const shown = skipped.slice(0, 5).join(', ');
  process.stderr.write(`note: skipped ${skipped.length} hidden path(s): ${shown}${skipped.length > 5 ? ', …' : ''} (use --include-hidden to publish them)\n`);
}

function printResult(result, urlOnly) {
  for (const w of result.warnings ?? []) process.stderr.write(`warning: ${w}\n`);
  if (urlOnly) console.log(result.links.latest);
  else console.log(JSON.stringify(result, null, 2));
}

async function cmdPublish(args) {
  const { values, positionals } = parseArgs({ args, options: PUBLISH_OPTS, allowPositionals: true });
  if (positionals.length !== 1) throw usage('publish takes exactly one file or directory');
  const options = publishOptions(values);
  const files = await collectFiles(positionals[0], collectOptions(values));
  reportSkipped();
  const cc = clientConfig();
  const result = await publish({ url: cc.url, token: cc.token, files, options });
  printResult(result, values['url-only']);
}

async function cmdScreenshot(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      ...PUBLISH_OPTS,
      mobile: { type: 'boolean' },
      viewport: { type: 'string' },
      'no-full-page': { type: 'boolean' },
      wait: { type: 'string' },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1) throw usage('screenshot takes exactly one URL');
  const target = positionals[0];
  try { new URL(target); } catch { throw usage(`not a URL: ${target}`); }
  const options = publishOptions(values);
  const shot = await screenshot(target, {
    mobile: values.mobile,
    viewport: values.viewport,
    fullPage: !values['no-full-page'],
    waitMs: values.wait ? Number(values.wait) : 0,
  });
  try {
    const files = await collectFiles(shot.path);
    const opts = options;
    if (!opts.name && !opts.to) opts.name = `Screenshot ${new URL(target).host}${new URL(target).pathname}`.replace(/\/$/, '');
    if (!opts.note) opts.note = `Screenshot of ${target}${values.mobile ? ' (mobile)' : ''}`;
    const cc = clientConfig();
    const result = await publish({ url: cc.url, token: cc.token, files, options: opts });
    printResult(result, values['url-only']);
  } finally {
    await shot.cleanup();
  }
}

async function cmdServe(args) {
  const { values } = parseArgs({ args, options: { config: { type: 'string' } } });
  const cfg = loadConfig({ file: values.config });
  const app = await createApp(cfg);
  const addr = await app.listen();
  defaultLog('info', 'listening', {
    address: `${addr.address}:${addr.port}`, dataDir: cfg.dataDir, identity: cfg.identity,
    owners: cfg.owners, publicUrl: cfg.publicUrl || '(from request)', tokens: app.tokens.list().length,
  });
  if (!app.tokens.list().length) defaultLog('warn', 'no publish tokens configured; run "tailnet-artifacts token create <name>"');
  if (!cfg.publicUrl) defaultLog('warn', 'ARTIFACTS_PUBLIC_URL is not set: only loopback Host headers are accepted, so requests through tailscale serve will get 421');
  if (!cfg.owners.length) defaultLog('warn', 'ARTIFACTS_OWNERS is empty: nobody can pin, extend or delete from the browser');
  if (cfg.host !== '127.0.0.1' && cfg.host !== '::1' && cfg.identity === 'tailscale') {
    defaultLog('warn', 'identity "tailscale" trusts Tailscale-User-* headers; only expose the server through `tailscale serve`');
  }
  const stop = async (sig) => {
    defaultLog('info', 'shutting down', { signal: sig });
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

async function cmdGc(args) {
  const { values } = parseArgs({ args, options: { config: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  const cfg = loadConfig({ file: values.config });
  const running = await fetch(`http://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${cfg.port}/healthz`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok, () => false);
  if (running) {
    throw new Error('the server is running and already collects garbage hourly (and on start); stop it first to run gc manually');
  }
  const store = new Store(cfg, { log: defaultLog });
  await store.init();
  const r = await store.gc({ dryRun: values['dry-run'] });
  for (const d of r.deleted) console.log(`${r.dryRun ? 'would delete' : 'deleted'}  ${d.id}  ${formatBytes(d.size)}  ${d.name}`);
  console.log(`${r.deleted.length} artifact(s), ${r.purgedTombstones} tombstone(s)${r.dryRun ? ' (dry run)' : ''}`);
}

async function cmdToken(args) {
  const { values, positionals } = parseArgs({ args, options: { config: { type: 'string' } }, allowPositionals: true });
  const [sub, name] = positionals;
  const cfg = loadConfig({ file: values.config });
  const tokens = new TokenStore(cfg.tokensFile);
  if (sub === 'create') {
    if (!name) throw usage('token create <name>');
    const token = tokens.create(name);
    console.error(`Created token "${name}". It is shown once; store it on the publishing machine:`);
    console.log(token);
  } else if (sub === 'list') {
    for (const n of tokens.list()) console.log(n);
  } else if (sub === 'revoke') {
    if (!name) throw usage('token revoke <name>');
    if (!tokens.revoke(name)) throw new Error(`no token named "${name}"`);
    console.error(`Revoked "${name}".`);
  } else {
    throw usage('token create <name> | list | revoke <name>');
  }
}

main(process.argv.slice(2)).catch((e) => {
  const err = e instanceof CliError
    ? { error: e.code, message: e.message, ...(e.status ? { status: e.status } : {}), ...(e.body && typeof e.body === 'object' ? { details: e.body } : {}) }
    : { error: e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e.code?.startsWith?.('ERR_PARSE_ARGS') ? 'usage' : 'error', message: e.message };
  console.error(JSON.stringify(err));
  process.exit(e.exitCode ?? (err.error === 'usage' ? 2 : 1));
});
