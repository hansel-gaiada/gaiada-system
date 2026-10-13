# .webdesk/deploy

The scripts this repo's deploy job (`.github/workflows/site.yml`) runs. They are COPIES: the source is
`webdesk/templates/_deploy/` in the Gaiada monorepo (documentation, the per-site secret's shape and the tests are there).
Do not edit them here; a change made here is overwritten by the next publish.

`bash .webdesk/deploy/test-secret-name.sh` proves the secret-name derivation against the fixture the ERP is tested with.
