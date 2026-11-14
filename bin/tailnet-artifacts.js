#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { loadConfig, withPublicUrl } from '../src/config.js';
import { createApp, defaultLog } from '../src/server.js';
import { Store } from '../src/store.js';
import { TokenStore, SCOPES, DEFAULT_SCOPE } from '../src/tokens.js';
import { clientConfig, collectFiles, publish, screenshot, CliError } from '../src/cli/client.js';
import { login, readToken, doctor, formatDoctor } from '../src/cli/setup.js';
import { installSkill, uninstallSkill, skillStatus, bundledSkill, SKILL_SOURCE } from '../src/cli/skill.js';
import { detectTailscaleUrl, waitForTailscaleUrl } from '../src/tailscale.js';
import { formatBytes } from '../src/util.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `tailnet-artifacts ${pkg.version} — versioned artifact links for your tailnet

Setup (client):
  artifacts login <server-url> [--token-stdin]   save the server URL and a token (prompted)
  artifacts doctor [--json] [--skip-browser]     check config, server, token, versions, browser,
                                                 agent skill
  artifacts skill install | status | uninstall   the agent skill that teaches agents to publish:
                  [--target claude|agents] [--dir <skills dir>]
    default targets: claude   ~/.claude/skills (Claude Code)
                     agents   ~/.agents/skills (Codex and other Agent Skills clients)
  artifacts skill print | path                   print the skill, or where the bundled copy is

Publishing (client):
  artifacts publish <file|dir> [--name "Title"] [--to <id>] [--note "what changed"]
                               [--by <agent or source>] [--ttl 30d | --keep]
                               [--entry page.html] [--expected-version N] [--url-only]
                               [--include-hidden]
  artifacts screenshot <url>   [--name "Title"] [--to <id>] [--mobile] [--viewport 1280,800]
                               [--no-full-page] [--wait 1000] [publish options...]

  Client config: ARTIFACTS_URL, ARTIFACTS_TOKEN, ARTIFACTS_BY
                 or ~/.config/tailnet-artifacts/{config.json,token} (written by login)
  Limits checked before upload: ARTIFACTS_MAX_PUBLISH_SIZE (50MB), ARTIFACTS_MAX_FILES (2000)
  Durations (--ttl): 30m, 12h, 7d, 2w.  --wait is in milliseconds.

  Directories: dotfiles (.env, .npmrc, …) and node_modules are skipped unless
  --include-hidden. Built apps must use relative asset paths (Vite: --base ./).

  Output: JSON on stdout (warnings also on stderr). On failure: JSON error on
  stderr and exit code 2 usage, 3 auth, 4 conflict, 5 not found/expired,
  6 too large/storage full, 7 network, 1 other.

Server (on a git, Docker or Proxmox install, run these as
  node <install dir>/bin/tailnet-artifacts.js <command>):
  tailnet-artifacts serve [--config file.json]
  tailnet-artifacts gc [--dry-run] [--config file.json]      (run while the server is stopped,
                                                              or rely on the server's hourly gc)
  tailnet-artifacts token create <name> [--scope publish|admin] | list | revoke <name>
                                                             [--config file.json]
    publish (default): create artifacts; change or delete only its own
    admin:             change or delete any artifact

  Server config: see README (ARTIFACTS_DATA_DIR, ARTIFACTS_PUBLIC_URL, ARTIFACTS_OWNERS, ...)
  ARTIFACTS_PUBLIC_URL defaults to this machine's https://<name>.<tailnet>.ts.net when
  the tailscale CLI is available.
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
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  switch (cmd) {
    case 'login': return cmdLogin(rest);
    case 'doctor': return cmdDoctor(rest);
    case 'skill': return cmdSkill(rest);
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
  let cfg = loadConfig({ file: values.config });
  if (!cfg.publicUrl && cfg.identity === 'tailscale') {
    const waitMs = parseWait(process.env.ARTIFACTS_TAILSCALE_WAIT);
    const ts = await waitForTailscaleUrl({
      waitMs,
      onWait: () => defaultLog('info', 'waiting for tailscale to report this machine\'s address', { maxSeconds: waitMs / 1000 }),
    });
    if (ts) {
      cfg = withPublicUrl(cfg, ts.url);
      defaultLog('info', 'detected public URL from tailscale', { publicUrl: ts.url });
      if (!ts.httpsEnabled) defaultLog('warn', 'HTTPS certificates are not enabled for this tailnet; `tailscale serve` cannot serve https until they are');
    }
  }
  const app = await createApp(cfg);
  const addr = await app.listen();
  defaultLog('info', 'listening', {
    address: `${addr.address}:${addr.port}`, dataDir: cfg.dataDir, identity: cfg.identity,
    owners: cfg.owners, publicUrl: cfg.publicUrl || '(from request)', tokens: app.tokens.list().length,
  });
  if (!app.tokens.list().length) defaultLog('warn', 'no publish tokens configured; create one with the "token create <name>" command (see docs/configuration.md#tokens)');
  if (!cfg.publicUrl) defaultLog('warn', 'ARTIFACTS_PUBLIC_URL is not set and could not be detected from tailscale: only loopback Host headers are accepted, so requests through tailscale serve will get 421');
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

function parseWait(v) {
  if (v == null || v === '') return 60000;
  if (!/^\d+$/.test(v)) throw usage(`ARTIFACTS_TAILSCALE_WAIT must be a number of seconds, got "${v}"`);
  return Number(v) * 1000;
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
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, scope: { type: 'string' } },
    allowPositionals: true,
  });
  const [sub, name] = positionals;
  const cfg = loadConfig({ file: values.config });
  const tokens = new TokenStore(cfg.tokensFile);
  if (sub === 'create') {
    if (!name) throw usage('token create <name> [--scope publish|admin]');
    const scope = values.scope ?? DEFAULT_SCOPE;
    if (!SCOPES.includes(scope)) throw usage(`--scope must be ${SCOPES.join(' or ')}`);
    const token = tokens.create(name, scope);
    let url = cfg.publicUrl;
    if (!url && cfg.identity === 'tailscale') url = (await detectTailscaleUrl())?.url;
    console.error(`Created ${scope} token "${name}". It is shown once. On the publishing machine run:\n\n`
      + `  artifacts login ${url || '<server-url>'}\n\nand paste it when asked.\n`);
    console.log(token);
  } else if (sub === 'list') {
    for (const t of tokens.list()) console.log(`${t.name}\t${t.scope}`);
  } else if (sub === 'revoke') {
    if (!name) throw usage('token revoke <name>');
    if (!tokens.revoke(name)) throw new Error(`no token named "${name}"`);
    console.error(`Revoked "${name}".`);
  } else {
    throw usage('token create <name> | list | revoke <name>');
  }
}

async function cmdLogin(args) {
  const { values, positionals } = parseArgs({ args, options: { 'token-stdin': { type: 'boolean' } }, allowPositionals: true });
  if (positionals.length !== 1) throw usage('login takes the server URL, e.g. artifacts login https://artifacts.example.ts.net');
  const token = await readToken({ piped: values['token-stdin'] || !process.stdin.isTTY });
  const result = await login(positionals[0], { token });
  console.error(`Logged in to ${result.url} as token "${result.token.name}" (${result.token.scope} scope).`);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSkill(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { target: { type: 'string', multiple: true }, dir: { type: 'string', multiple: true }, json: { type: 'boolean' } },
    allowPositionals: true,
  });
  const [sub, ...extra] = positionals;
  if (extra.length) throw usage(`unexpected argument: ${extra[0]}`);
  const opts = { target: values.target ?? [], dir: values.dir ?? [] };
  if (sub === 'print') { process.stdout.write(bundledSkill()); return; }
  if (sub === 'path') { console.log(SKILL_SOURCE); return; }
  const run = { install: installSkill, uninstall: uninstallSkill, status: skillStatus }[sub];
  if (!run) throw usage('skill install | status | uninstall | print | path');
  const results = run(opts);
  if (values.json) { console.log(JSON.stringify(results, null, 2)); return; }
  for (const r of results) console.log(`${(r.action ?? r.state).padEnd(10)} ${r.path}  (${r.label})`);
  if (sub === 'install') {
    console.error('\nAgents load skills when a task matches, so also add this line to your agent\'s\n'
      + 'always-on instructions (CLAUDE.md, AGENTS.md, GEMINI.md, …):\n\n'
      + '  When you build or change anything visual, publish it with the tailnet-artifacts skill and reply with the link.\n');
  }
  if (sub === 'status' && results.some((r) => r.state !== 'current')) process.exitCode = 1;
}

async function cmdDoctor(args) {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' }, 'skip-browser': { type: 'boolean' } } });
  const result = await doctor({ browser: !values['skip-browser'] });
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else process.stdout.write(formatDoctor(result));
  if (!result.ok) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((e) => {
  const err = e instanceof CliError
    ? { error: e.code, message: e.message, ...(e.status ? { status: e.status } : {}), ...(e.body && typeof e.body === 'object' ? { details: e.body } : {}) }
    : { error: e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e.code?.startsWith?.('ERR_PARSE_ARGS') ? 'usage' : 'error', message: e.message };
  console.error(JSON.stringify(err));
  process.exit(e.exitCode ?? (err.error === 'usage' ? 2 : 1));
});
