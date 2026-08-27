// webdesk/sites/wsk17-proof/astro.config.mjs
//
// WSK-17 -- static output. The site's own build script (scripts/seed-and-generate.sh) stands up a
// live /v1 dev stack BEFORE `astro build` runs, so every page below fetches real data at build
// time through the generated SDK -- this is not a fixture-fed static site, it genuinely reads
// Postgres through the frozen /v1 envelope once per build.
import { defineConfig } from 'astro/config'

export default defineConfig({
  output: 'static',
})
