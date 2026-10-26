# Replaying grizzly's `sdk-unit` suite

How to produce the miss count on the target suite (`typescript/sdk`, japa 5.0.0, 164 tests).
The replay harness is `packages/core/scripts/replay.mjs`; this file is only the wiring, which is
not committed in the grizzly clone.

## Wiring

1. Link the packages into the suite's resolution path:

```bash
cd ~/projects/grizzly/grizzly-sv-cbd/typescript/sdk
mkdir -p node_modules/@spikedpunch
ln -sfn /Users/spikedpunchvictim/projects/cbd/packages/core      node_modules/@spikedpunch/cbd
ln -sfn /Users/spikedpunchvictim/projects/cbd/packages/japa      node_modules/@spikedpunch/cbd-japa
```

2. A patch the harness applies after every checkout (`--patch`), because the harness checks
   commits out in place and the wiring must not be committed:

```diff
diff --git a/typescript/sdk/bin/test.ts b/typescript/sdk/bin/test.ts
index cf112980b..2f946ddc1 100644
--- a/typescript/sdk/bin/test.ts
+++ b/typescript/sdk/bin/test.ts
@@ -3,6 +3,7 @@ import * as reporters from '@japa/runner/reporters'
 import { processCLIArgs, configure, run } from '@japa/runner'
 import { NamedReporterContract } from '@japa/runner/types'
 import { inspect } from 'node:util'
+import { cbd } from '@spikedpunch/cbd-japa'
 
 /*
 |--------------------------------------------------------------------------
@@ -42,7 +43,8 @@ configure({
     }
   ],
   plugins: [
-    assert()
+    assert(),
+    // @ts-expect-error — CBD types its plugin against japa 5.4's PluginFn
+    cbd()
   ],
```

The cast is needed because grizzly pins japa 5.0.0 and the adapter is typed against 5.4's
`PluginFn`. The runtime surface it uses (`test:start`, `test:end`, `runner:end`) is the same.

## Running one commit

```bash
cd packages/core
node scripts/replay.mjs \
  --repo "$HOME/projects/grizzly/grizzly-sv-cbd" \
  --base <commit>^ --head <commit> \
  --state /tmp/replay/<short> \
  --full-cmd "cd typescript/sdk && TS_NODE_TRANSPILE_ONLY=1 TS_NODE_PROJECT=tsconfig.test.json node --import ts-node-maintained/register/esm bin/test.ts sdk-unit" \
  --patch /path/to/grizzly-cbd.patch \
  --include "$HOME/projects/grizzly/grizzly-sv-cbd/typescript/sdk/src" \
  --json /tmp/replay/<short>.json
```

`--include sdk/src` is what makes a real commit answerable: the repository's own config includes
`typescript/**`, so a change to `typescript/sdk/package.json` or `SDK_UPDATE.md` is in scope and
unknown to the map, which escalates every such commit to `all`.

## Limitations found while wiring it

- **`TS_NODE_TRANSPILE_ONLY=1` is required.** Commits from early October no longer typecheck
  against the clone's current `node_modules` (`'dec.key' is possibly 'undefined'`); without the
  flag the base run dies at import time and the harness has no map to select against.
- **Commits before `typescript/sdk/bin/test.ts` existed cannot be replayed.** The base run has no
  runner, so there is no map. Five of the ten first-parent commits touching `sdk/src` are in that
  group.
- **The subset command loads every spec file.** Selection narrows which tests *run* (the adapter
  applies a title filter), not which files the runner imports, so `T_subset == T_full` (1.7 s each)
  and the harness's time saving is ~0. Narrowing loading needs a file-level selection the wiring
  does not provide (`cbd select --emit-selection-dir --suite` is the product seam for it).
- The harness reads the repository's `cbd.config.json` (selection policy) since this work; before
  that, grizzly's `unknownPolicyFor: tools/** -> ignore` was invisible and 20 of 20 window steps
  escalated to `all`.
