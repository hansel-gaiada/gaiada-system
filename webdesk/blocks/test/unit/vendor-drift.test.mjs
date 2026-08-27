// webdesk/blocks/test/unit/vendor-drift.test.mjs
//
// WSK-16 — repo-local-only sanity check that the vendored vocabulary (src/vocabulary/*.ts) has
// not drifted from webdesk/payload/vocabulary/*.ts since the last `npm run vendor:vocabulary`.
// This test can only run FROM INSIDE this repo (it reads ../../../payload/vocabulary directly) —
// it is intentionally NOT part of what `npm pack` ships (package.json's "files" excludes test/),
// so it has no bearing on the installed tarball. It exists so the drift the CI-facing
// `vendor:check` script catches also shows up in a plain `npm run test:unit` pass during dev.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..')

test('src/vocabulary/*.ts is byte-identical (minus the vendoring banner) to webdesk/payload/vocabulary/*.ts', () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'vendor-vocabulary.mjs'), '--check'], {
      cwd: PACKAGE_ROOT,
      stdio: 'pipe',
    })
  }, 'vendor-vocabulary.mjs --check failed — run `npm run vendor:vocabulary` and commit the result')
})
