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

1. Make sure the npm account or organization that owns `@spikedpunch` can publish
   public scoped packages.
2. Add an Actions secret named **`NPM_TOKEN`** to the repository
   (Settings → Secrets and variables → Actions). A granular access token with
   read-and-write access to the `@spikedpunch` scope is enough; an automation
   token avoids the 2FA prompt.
3. Optionally add required reviewers to the `npm` environment the workflow uses,
   so a publish waits for approval.

Provenance is signed with GitHub's OIDC identity (`id-token: write`) and requires
the repository to be public. This repository is.

## Cut a release

Every package shares one version:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The tag is the release. The workflow:

1. installs with `--frozen-lockfile`;
2. runs `pnpm -r test` — a tag can point at a commit CI never saw, so the publish
   gate is its own;
3. stamps the tag's version into every `packages/*/package.json` (in the runner's
   checkout only — no version commit is needed, `0.0.0` stays in the repository);
4. runs `pnpm -r publish` in dependency order, so the core is available before the
   adapters; `workspace:*` becomes the stamped version in the packed manifests;
5. uploads with `--access public --provenance`.

A prerelease tag (`v0.2.0-rc.1`) publishes under the `next` dist-tag; a final tag
publishes under `latest`.

To publish without a tag, run **Actions → Publish to npm → Run workflow** with the
version, dist-tag and whether to dry-run.

## Checks before tagging

- `pnpm -r test` is green locally (CI runs it again).
- `npm pack --dry-run` in a package lists only `dist/src` (and the CLI's
  `bin/cbd.js`, the core's schema, the Jest adapter's `dist/cjs`) — the `files`
  field is what keeps compiled tests out of the tarball.
- The version has not been published before; npm rejects a republished version,
  and the workflow does not overwrite one.

The first publish of each package needs the token. After that, the packages can
be moved to npm's trusted publishing (OIDC) and `NPM_TOKEN` removed.
