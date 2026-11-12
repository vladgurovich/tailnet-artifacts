// Prepares a release: node scripts/release.mjs 0.3.0 [--push]
//
// 1. Checks the working tree is clean and on main.
// 2. Bumps package.json / package-lock.json.
// 3. Replaces the pinned v<old> install references in README.md and docs/deploy.md.
// 4. Turns "## Unreleased" in CHANGELOG.md into "## <version> — <date>".
// 5. Runs the unit tests, commits, and creates an annotated tag.
// 6. With --push, pushes main and the tag (which triggers the Release workflow).
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [version, ...flags] = process.argv.slice(2);
const push = flags.includes('--push');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim();
const fail = (msg) => { console.error(`release: ${msg}`); process.exit(1); };

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail('usage: node scripts/release.mjs <x.y.z> [--push]');
if (run('git', ['status', '--porcelain'])) fail('working tree is not clean');
if (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('not on main');
if (run('git', ['tag', '--list', `v${version}`])) fail(`tag v${version} already exists`);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const old = pkg.version;
if (old === version) fail(`package.json is already ${version}`);

const changelog = readFileSync('CHANGELOG.md', 'utf8');
if (!/^## Unreleased\s*$/m.test(changelog)) fail('CHANGELOG.md has no "## Unreleased" section to release');
const today = new Date().toISOString().slice(0, 10);
writeFileSync('CHANGELOG.md', changelog.replace(/^## Unreleased\s*$/m, `## ${version} — ${today}`));

for (const file of ['README.md', 'docs/deploy.md']) {
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replaceAll(`v${old}`, `v${version}`));
}

run('npm', ['version', version, '--no-git-tag-version'], { stdio: 'ignore' });
console.log(`release: ${old} -> ${version}; running tests…`);
run('npm', ['test'], { stdio: 'inherit' });

run('git', ['commit', '-am', `Release v${version}`]);
run('git', ['tag', '-a', `v${version}`, '-m', `v${version}`]);
console.log(`release: committed and tagged v${version}`);

if (push) {
  run('git', ['push', 'origin', 'main', `v${version}`], { stdio: 'inherit' });
  console.log('release: pushed; the Release workflow publishes the GitHub Release, image and npm package');
} else {
  console.log(`release: push with: git push origin main v${version}`);
}
