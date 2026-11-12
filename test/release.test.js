// The release script must update install pins and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bumpPins, PIN_FILES } from '../scripts/pins.mjs';

test('install pins are updated', () => {
  const before = [
    'npm install -g git+https://github.com/vladgurovich/tailnet-artifacts.git#v0.3.0',
    'curl -fsSLO https://raw.githubusercontent.com/vladgurovich/tailnet-artifacts/v0.3.0/deploy/docker/compose.yaml',
    'curl -fsSL https://github.com/vladgurovich/tailnet-artifacts/archive/refs/tags/v0.3.0.tar.gz',
    'git clone --branch v0.3.0 https://github.com/vladgurovich/tailnet-artifacts.git',
    'git checkout v0.3.0 && npm ci',
    'VERSION="v0.3.0"',
    'ARTIFACTS_VERSION=0.3.0',
    'image: ghcr.io/vladgurovich/tailnet-artifacts:0.3.0',
  ].join('\n');
  const after = bumpPins(before, '0.3.0', '0.3.1');
  assert.ok(!after.includes('0.3.0'), after);
  assert.equal(after.match(/0\.3\.1/g).length, 8);
});

test('prose that mentions a version is left alone', () => {
  const prose = [
    'Tokens created before v0.3.0 have no scope and are treated as admin.',
    'Regression tests for the v0.3.0 security review.',
    '## 0.3.0 — 2026-11-12',
    'Pin ARTIFACTS_VERSION to a release such as 0.3.0.',
    'VERSION="v0.3.0" # not at line start: x',
  ].join('\n');
  assert.equal(bumpPins(prose, '0.3.0', '0.3.1').split('\n').slice(0, 4).join('\n'), prose.split('\n').slice(0, 4).join('\n'));
});

test('a similar version is not touched', () => {
  assert.equal(bumpPins('git checkout v0.3.10', '0.3.1', '0.3.2'), 'git checkout v0.3.10');
  assert.equal(bumpPins('ARTIFACTS_VERSION=0.3.10', '0.3.1', '0.3.2'), 'ARTIFACTS_VERSION=0.3.10');
});

test('every pinned file exists', () => {
  for (const f of PIN_FILES) assert.ok(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').length > 0, f);
});
