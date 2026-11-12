// Prints the CHANGELOG.md section for a version: node scripts/changelog-section.mjs 0.3.0
import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('usage: changelog-section.mjs <version>');
  process.exit(2);
}
const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const start = text.search(new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b.*$`, 'm'));
if (start < 0) {
  console.error(`no "## ${version}" section in CHANGELOG.md`);
  process.exit(1);
}
const rest = text.slice(start);
const next = rest.slice(1).search(/^## /m);
const section = next < 0 ? rest : rest.slice(0, next + 1);
process.stdout.write(`${section.split('\n').slice(1).join('\n').trim()}\n`);
