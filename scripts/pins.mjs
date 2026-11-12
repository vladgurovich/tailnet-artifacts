// Version pins that the release script updates. Only install references match:
// prose such as "tokens created before v0.3.0" or "the v0.2.0 review" never does.
export const PIN_FILES = [
  'README.md',
  'docs/deploy.md',
  'docs/platforms.md',
  'deploy/proxmox/create-lxc.sh',
  'deploy/docker/.env.example',
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Returns text with every install pin of `old` (x.y.z, no "v") replaced by `next`. */
export function bumpPins(text, old, next) {
  const o = esc(old);
  const rules = [
    [new RegExp(`(\\.git#v)${o}\\b`, 'g'), `$1${next}`], // npm install …git#vX
    [new RegExp(`(/tailnet-artifacts/v)${o}(/)`, 'g'), `$1${next}$2`], // raw.githubusercontent …/vX/path
    [new RegExp(`(refs/tags/v)${o}\\b`, 'g'), `$1${next}`], // archive tarballs
    [new RegExp(`(--branch v)${o}\\b`, 'g'), `$1${next}`], // git clone --branch vX
    [new RegExp(`(checkout v)${o}\\b`, 'g'), `$1${next}`], // git checkout vX
    [new RegExp(`(^VERSION="v)${o}(")`, 'gm'), `$1${next}$2`], // create-lxc.sh default
    [new RegExp(`(^ARTIFACTS_VERSION=)${o}$`, 'gm'), `$1${next}`], // .env.example
    [new RegExp(`(tailnet-artifacts:)${o}\\b`, 'g'), `$1${next}`], // image references
  ];
  return rules.reduce((t, [re, to]) => t.replace(re, to), text);
}
