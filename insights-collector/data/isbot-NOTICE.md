# isbot pattern list: notice

`isbot-patterns.json` is the user-agent pattern list of the npm package **isbot 5.2.2**
(<https://github.com/omrilotan/isbot>, `src/patterns.json`, extracted unchanged from the published
`index.mjs`). The patterns are JavaScript regular expressions, matched case-insensitively; the collector
runs them with `github.com/dlclark/regexp2` because several use lookahead or lookbehind, which Go's
standard `regexp` does not support.

Licence: **Unlicense** (public domain dedication), text in `isbot-LICENSE.txt`. (The M5 phase 5 design
says "MIT"; the package's own licence file says Unlicense. Either way no attribution is required;
this notice is kept for provenance.)

To refresh: `npm pack isbot@<version>`, re-extract `patterns_default` from `index.mjs` into
`isbot-patterns.json`, update the version above, run `go test ./internal/bot/...`.
