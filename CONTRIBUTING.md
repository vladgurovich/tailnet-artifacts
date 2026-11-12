# Contributing

Thanks for helping. Issues and pull requests are welcome; for anything bigger
than a bug fix, please open an issue first so we can agree on the approach.

## Setup

```sh
git clone https://github.com/vladgurovich/tailnet-artifacts.git
cd tailnet-artifacts
npm install
npx playwright install chromium   # for the browser tests
```

## Checks

```sh
npm test               # unit, HTTP and CLI tests
npm run test:browser   # gallery, viewer and screenshot tests in headless Chromium
npm run coverage       # both, with a coverage report
```

CI runs both suites; please make sure they pass and add a test for every bug fix
or new behavior.

## Principles

- **One runtime dependency.** The server and CLI use Node's standard library plus
  `marked`. New runtime dependencies need a strong reason; dev dependencies for
  testing are fine.
- **Trusted pages never render artifact content.** Content is only ever served
  under `/a/<id>/v/<n>/` with the sandbox headers, and loaded in sandboxed frames.
- **Keep homelab specifics out.** Anything environment-specific belongs in
  configuration, not code or docs.
- **Agents are users.** CLI output is JSON with stable fields; errors are JSON on
  stderr with meaningful exit codes. Treat changes to them as breaking.

## Releases

1. Move the `Unreleased` section of `CHANGELOG.md` under the new version.
2. Bump the version in `package.json`, `package-lock.json` (`npm install --package-lock-only`)
   and the pinned install lines in `README.md` and `docs/deploy.md`.
3. Commit, tag `vX.Y.Z`, and push the tag.

Security issues: see [SECURITY.md](SECURITY.md), not the issue tracker.
