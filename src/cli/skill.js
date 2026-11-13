// `artifacts skill`: install the bundled Agent Skill (skills/tailnet-artifacts/SKILL.md)
// where agents look for user-level skills. https://agentskills.io
import { mkdirSync, readFileSync, writeFileSync, rmSync, rmdirSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from './client.js';

export const SKILL_NAME = 'tailnet-artifacts';
export const SKILL_SOURCE = fileURLToPath(new URL(`../../skills/${SKILL_NAME}/SKILL.md`, import.meta.url));

/**
 * User-level skill directories. Claude Code reads its own; `~/.agents/skills` is the
 * shared location read by Codex, Gemini CLI, GitHub Copilot, Cursor, OpenCode and
 * other Agent Skills clients.
 */
export function skillTargets(env = process.env) {
  const home = env.HOME || homedir();
  return {
    claude: { label: 'Claude Code', dir: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills') },
    agents: { label: 'Agent Skills clients (~/.agents/skills)', dir: join(home, '.agents', 'skills') },
  };
}
export const TARGET_NAMES = ['claude', 'agents'];

export function bundledSkill() {
  return readFileSync(SKILL_SOURCE, 'utf8');
}

function read(file) {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

function realDir(dir) {
  // Resolve the deepest existing ancestor so two names for one directory dedupe.
  let d = resolve(dir);
  const rest = [];
  while (!existsSync(d) && dirname(d) !== d) { rest.unshift(d.slice(dirname(d).length + 1)); d = dirname(d); }
  try { return join(realpathSync(d), ...rest); } catch { return resolve(dir); }
}

/** Pick targets from --target / --dir. Returns [{ name, label, dir }], deduplicated. */
export function selectTargets({ target = [], dir = [] } = {}, env = process.env) {
  const all = skillTargets(env);
  for (const t of target) {
    if (!TARGET_NAMES.includes(t)) throw new CliError('usage', `--target must be ${TARGET_NAMES.join(' or ')}, got "${t}"`, { exitCode: 2 });
  }
  const picked = [
    ...(target.length || dir.length ? target : TARGET_NAMES).map((n) => ({ name: n, ...all[n] })),
    ...dir.map((d) => ({ name: 'dir', label: 'custom directory', dir: resolve(d) })),
  ];
  const seen = new Set();
  return picked.filter((t) => {
    const key = realDir(t.dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function statusOf(t, bundled) {
  const file = join(t.dir, SKILL_NAME, 'SKILL.md');
  const installed = read(file);
  const state = installed == null ? 'missing' : installed === bundled ? 'current' : 'outdated';
  return { target: t.name, label: t.label, path: file, state };
}

export function skillStatus(opts, env) {
  const bundled = bundledSkill();
  return selectTargets(opts, env).map((t) => statusOf(t, bundled));
}

export function installSkill(opts, env) {
  const bundled = bundledSkill();
  return selectTargets(opts, env).map((t) => {
    const before = statusOf(t, bundled);
    if (before.state !== 'current') {
      mkdirSync(dirname(before.path), { recursive: true });
      writeFileSync(before.path, bundled);
    }
    return { ...before, state: 'current', action: { missing: 'installed', outdated: 'updated', current: 'unchanged' }[before.state] };
  });
}

export function uninstallSkill(opts, env) {
  return selectTargets(opts, env).map((t) => {
    const file = join(t.dir, SKILL_NAME, 'SKILL.md');
    const text = read(file);
    let action = 'not installed';
    if (text != null) {
      if (!/^name:\s*tailnet-artifacts\s*$/m.test(text)) {
        action = 'skipped (not this skill)';
      } else {
        rmSync(file);
        try { if (!readdirSync(dirname(file)).length) rmdirSync(dirname(file)); } catch { /* keep */ }
        action = 'removed';
      }
    }
    return { target: t.name, label: t.label, path: file, action };
  });
}

/** One line for `artifacts doctor`. */
export function skillCheck(env) {
  if (!existsSync(SKILL_SOURCE)) return { status: 'ok', detail: 'not bundled with this install (server-only); install the CLI where agents run' };
  const st = skillStatus({}, env);
  const current = st.filter((s) => s.state === 'current');
  const outdated = st.filter((s) => s.state === 'outdated');
  if (outdated.length) {
    return { status: 'warn', detail: `outdated in ${outdated.map((s) => s.target).join(', ')}; run: artifacts skill install` };
  }
  if (current.length === st.length) return { status: 'ok', detail: `installed for ${current.map((s) => s.target).join(' and ')}` };
  const missing = st.filter((s) => s.state === 'missing').map((s) => s.target).join(', ');
  return { status: 'warn', detail: `${current.length ? `not installed for ${missing}` : 'not installed'}; run: artifacts skill install` };
}
