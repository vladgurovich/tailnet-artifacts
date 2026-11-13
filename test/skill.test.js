// The bundled Agent Skill and `artifacts skill`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.js';
import {
  SKILL_SOURCE, SKILL_NAME, bundledSkill, installSkill, uninstallSkill, skillStatus, skillCheck, selectTargets,
} from '../src/cli/skill.js';

async function newHome(t) {
  const d = await tempDir();
  t.after(d.cleanup);
  return d.dir;
}

const BIN = fileURLToPath(new URL('../bin/tailnet-artifacts.js', import.meta.url));
const run = (args, env) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'SKILL.md starts with YAML frontmatter');
  return Object.fromEntries(m[1].split('\n').map((l) => l.match(/^(\w[\w-]*):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2]]));
}

test('SKILL.md follows the Agent Skills spec', () => {
  const fm = frontmatter(bundledSkill());
  assert.equal(fm.name, SKILL_NAME);
  assert.equal(basename(dirname(SKILL_SOURCE)), fm.name, 'name matches the directory');
  assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(fm.name.length <= 64);
  assert.ok(fm.description.length > 50 && fm.description.length <= 1024, 'description is 1–1024 chars');
  assert.ok(!fm.compatibility || fm.compatibility.length <= 500);
});

test('every command and flag the skill mentions exists in the CLI help', async (t) => {
  const help = (await run(['help'])).stdout;
  const text = bundledSkill();
  const cmds = [...text.matchAll(/(?:`|^)artifacts (\w+)/gm)].map((m) => m[1]);
  assert.ok(cmds.length >= 3);
  for (const c of new Set(cmds)) assert.ok(help.includes(`artifacts ${c}`), `help mentions "artifacts ${c}"`);
  const flags = [...text.matchAll(/(?<![\w-])--[a-z][a-z-]+/g)].map((m) => m[0]).filter((f) => !['--base', '--help'].includes(f));
  for (const f of new Set(flags)) assert.ok(help.includes(f), `help mentions ${f}`);
});

test('the npm package ships the skill', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('skills'));
});

test('install, status and uninstall for Claude Code and ~/.agents/skills', async (t) => {
  const home = await newHome(t);
  const env = { HOME: home };
  assert.deepEqual(skillStatus({}, env).map((s) => s.state), ['missing', 'missing']);
  assert.equal(skillCheck(env).status, 'warn');

  const r = installSkill({}, env);
  assert.deepEqual(r.map((x) => x.action), ['installed', 'installed']);
  for (const p of [join(home, '.claude/skills/tailnet-artifacts/SKILL.md'), join(home, '.agents/skills/tailnet-artifacts/SKILL.md')]) {
    assert.equal(readFileSync(p, 'utf8'), bundledSkill());
  }
  assert.deepEqual(installSkill({}, env).map((x) => x.action), ['unchanged', 'unchanged']);
  assert.deepEqual(skillCheck(env), { status: 'ok', detail: 'installed for claude and agents' });

  writeFileSync(join(home, '.agents/skills/tailnet-artifacts/SKILL.md'), '---\nname: tailnet-artifacts\n---\nold\n');
  assert.equal(skillStatus({ target: ['agents'] }, env)[0].state, 'outdated');
  assert.match(skillCheck(env).detail, /outdated in agents/);
  assert.equal(installSkill({ target: ['agents'] }, env)[0].action, 'updated');

  assert.deepEqual(uninstallSkill({}, env).map((x) => x.action), ['removed', 'removed']);
  assert.ok(!existsSync(join(home, '.claude/skills/tailnet-artifacts')), 'empty skill dir removed');
  assert.ok(existsSync(join(home, '.claude/skills')), 'skills dir kept');
});

test('CLAUDE_CONFIG_DIR, --dir and deduplication', async (t) => {
  const home = await newHome(t);
  const cfg = join(home, 'claude-cfg');
  assert.equal(selectTargets({}, { HOME: home, CLAUDE_CONFIG_DIR: cfg })[0].dir, join(cfg, 'skills'));

  // ~/.claude/skills symlinked to ~/.agents/skills: one copy, not two.
  mkdirSync(join(home, '.agents/skills'), { recursive: true });
  mkdirSync(join(home, '.claude'));
  symlinkSync(join(home, '.agents/skills'), join(home, '.claude/skills'));
  assert.equal(selectTargets({}, { HOME: home }).length, 1);

  const custom = join(home, 'other-agent/skills');
  const only = selectTargets({ dir: [custom] }, { HOME: home });
  assert.deepEqual(only.map((t) => t.dir), [custom], '--dir alone replaces the defaults');
  assert.throws(() => selectTargets({ target: ['nope'] }, { HOME: home }), /--target must be/);
});

test('uninstall leaves a different skill with the same directory name alone', async (t) => {
  const home = await newHome(t);
  const p = join(home, '.agents/skills/tailnet-artifacts/SKILL.md');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '---\nname: something-else\n---\n');
  assert.equal(uninstallSkill({ target: ['agents'] }, { HOME: home })[0].action, 'skipped (not this skill)');
  assert.ok(existsSync(p));
});

test('artifacts skill CLI', async (t) => {
  const home = await newHome(t);
  const env = { HOME: home, CLAUDE_CONFIG_DIR: '' };
  assert.equal((await run(['skill', 'status'], env)).code, 1);
  const inst = await run(['skill', 'install', '--json'], env);
  assert.equal(inst.code, 0);
  assert.deepEqual(JSON.parse(inst.stdout).map((r) => r.action), ['installed', 'installed']);
  assert.equal((await run(['skill', 'status'], env)).code, 0);
  assert.equal((await run(['skill', 'print'], env)).stdout, bundledSkill());
  assert.equal((await run(['skill', 'path'], env)).stdout.trim(), SKILL_SOURCE);
  const bad = await run(['skill', 'frobnicate'], env);
  assert.equal(bad.code, 2);
  assert.equal(JSON.parse(bad.stderr).error, 'usage');
});

test('doctor shows the skill check', async (t) => {
  const home = await newHome(t);
  const r = await run(['doctor', '--json', '--skip-browser'], { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), ARTIFACTS_URL: '', ARTIFACTS_TOKEN: '', CLAUDE_CONFIG_DIR: '' });
  const check = JSON.parse(r.stdout).checks.find((c) => c.name === 'agent skill');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /artifacts skill install/);
});
