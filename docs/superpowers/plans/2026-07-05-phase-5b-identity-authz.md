# Phase 5b — Identity & Authorization to Spec (full-fidelity)

> Governing: full-fidelity mandate + `ws1-rbac-engine.md`. TDD; commit per task; update the
> checklist. Closes the recorded deviations "dev/service auth not IdP" and "in-code policy
> not Cerbos". Locked constraints: D4 (assurance tiers, platform mints principal), D5 (RLS
> set), D11 (authoritative revocation), D16 (PlanResources for set-returning).

## Decisions
- **IdP: Keycloak** (most battle-tested OIDC; realm = the Gaiada org; groups/roles map to
  platform roles). Provider-agnostic verification (JWKS + issuer) so a Zitadel swap is config.
- **Cerbos** as the policy decision point; policies as a versioned YAML repo tested in CI with
  the Cerbos compiler; the in-code `check()` is retired but its test matrix is preserved as
  Cerbos policy tests (behavioral parity gate).

## Tasks (order)

- [ ] **5b.1 OIDC verification** — `platform/src/auth/oidc.ts`: verify a Bearer JWT against the
  IdP JWKS (jose), check issuer/audience, extract subject/email; auto-provision the `users` row
  on first login (linked by IdP subject in a new `users.idp_subject` column). `x-user-id`
  dev-auth stays behind `AUTH_MODE=dev` (tests + local); `AUTH_MODE=oidc` requires a valid JWT.
  Tests: sign a token with an in-test JWK, assert principal assembly + auto-provision + reject
  bad iss/aud/expired.
- [ ] **5b.2 Keycloak service + realm** — compose service (both files), realm-export JSON
  (realm `gaiada`, a confidential client for the platform, a public client for the future UI,
  a `group_executive` + company roles), `docs/runbooks/idp-keycloak.md` (bootstrap, user
  provisioning, MFA policy, token TTL config).
- [ ] **5b.3 Cerbos policy repo + tests** — `platform/cerbos/policies/*.yaml` (resource policies
  per kind: project, task, client, company, rollup, agency_campaign, agency_approval; derived
  roles for the scope cascade) + `cerbos/policies/*_test.yaml` mirroring `policy.test.ts` cases;
  `npm run cerbos:test` compiles + runs them. Assurance is a principal attr; low → deny company data.
- [ ] **5b.4 Cerbos client replaces in-code check()** — `platform/src/rbac/cerbos.ts`: `check()` +
  `planResources()` calling Cerbos over HTTP; `core/http.ts` authorize() uses it; set-returning
  reads (`/projects`, activity, rollups) use PlanResources → predicate pushed into the RLS query
  (D16). Delete `rbac/policy.ts` in-code engine; keep `principal.ts`. Live Cerbos round-trip test;
  full platform + agency suites stay green (behavioral parity).
- [ ] **5b.5 Step-up MFA + dual-proof enrollment (D4.4)** — `/identity/enroll/start` (issues a
  one-time WA/TG proof code) + `/identity/enroll/confirm` (code + a valid MFA'd IdP token) →
  sets `identity_links.verified_at`. Sensitive/bulk/cross-tenant actions require `assurance:high`
  (only an MFA'd IdP session grants it); a linked-but-not-stepped-up session stays `linked`.
  Tests: enroll flow sets verified_at only with both proofs; step-up gate on a sensitive action.
- [ ] **5b.6 Authoritative revocation (D11)** — minute-scale access-token TTL (Keycloak config) +
  a server-side session-version/deny-list checked on EVERY sensitive platform path AND every MCP
  hub tool call; SOC/admin "revoke" bumps `users.session_version`. Hub calls `/principal/verify`
  (or caches with a short TTL keyed on session_version). Tests: revoke → next hub call denied.
- [ ] **5b.7 Team scope** — team-scope grants + `team_memberships`-derived coverage in Cerbos
  (currently unimplemented tier). Tests: a team-lead role covers that team's projects only.
- [ ] **5b.8 Phase e2e + docs** — OIDC login (signed token) → Cerbos-authorized CRUD → step-up
  gate → revocation cutoff, end to end; retire the "in-code policy / dev-auth" deviations in the
  register; READMEs + CLAUDE.md.

**Runs-in-Docker verification:** Keycloak, Cerbos, and Postgres all run locally via compose;
tasks that touch them get a live round-trip test (as with OpenBao/Redis/PG in 5a).
