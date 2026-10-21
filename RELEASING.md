# Releasing to npm

Publishing runs in GitHub Actions; nothing is published from a developer machine.

| Package | Contents |
| --- | --- |
| `@spikedpunch/cbd` | core, plus `cbd.config.schema.json` |
| `@spikedpunch/cbd-cli` | the `cbd` binary and `dist/src` |
| `@spikedpunch/cbd-japa` | adapter |
| `@spikedpunch/cbd-mocha` | adapter |
| `@spikedpunch/cbd-vitest` | adapter and `./setup` |
| `@spikedpunch/cbd-jest` | adapter, `./environment` and `./config` (CJS) |
| `@spikedpunch/cbd-node-test` | adapter and `./register` |

`@spikedpunch/cbd-fixture` and `@spikedpunch/cbd-probe` stay private.

## One-time setup

Publishing uses npm **trusted publishing** (OIDC). No `NPM_TOKEN` secret is used
or needed; do not add one to the publish step.

1. Make sure the npm account or organization that owns `@spikedpunch` can publish
   public scoped packages.
2. For each package, add a trusted publisher on npmjs.com
   (package → Settings → Trusted publishing): repository
   `SpikedPunchVictim/cbd`, workflow file `publish.yml`, environment `npm`.
   The first publish of a package that has never been published still needs a
   one-off token or manual `npm publish`; trusted publishing can be configured
   only after the package exists.
3. Optionally add required reviewers to the `npm` environment the workflow uses,
   so a publish waits for approval.

The workflow grants `id-token: write`; pnpm 11 publishes natively, exchanges the
GitHub OIDC token for registry credentials, and attaches provenance automatically
for a public package from a public repository. No `--provenance` flag and no
`registry-url` auth line are used.

## Cut a release

Every package shares one version:

```sh
git tag v0.0.4
git push origin v0.0.4
```

The tag is the release. The workflow:

1. installs with `--frozen-lockfile`;
2. runs `pnpm -r test` — a tag can point at a commit CI never saw, so the publish
   gate is its own;
3. stamps the tag's version into every `packages/*/package.json` (in the runner's
   checkout only — no version commit is needed);
4. runs `pnpm -r publish` in dependency order, so the core is available before the
   adapters; `workspace:*` becomes the stamped version in the packed manifests;
5. publishes with `--access public`; trusted publishing supplies the credentials
   and provenance.

A prerelease tag (`v0.2.0-rc.1`) publishes under the `next` dist-tag; a final tag
publishes under `latest`.

To publish without a tag, run **Actions → Publish to npm → Run workflow** with the
version, dist-tag and whether to dry-run.

## Checks before tagging

- `pnpm -r test` is green locally (CI runs it again).
- `npm pack --dry-run` in a package lists only `dist/src` (and the CLI's
  `bin/cbd.js`, the core's schema, the Jest adapter's `dist/cjs`, and the generated
  `CHANGELOG.md`) — the `files` field is what keeps compiled tests out of the tarball.
- The version has not been published before; npm rejects a republished version,
  and the workflow does not overwrite one.

A publish from any identity other than the configured trusted publisher — another
workflow file, another environment, or a local machine — fails with a 401, even
with a green build. That is the intended boundary.
