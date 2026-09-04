# OQ-2.6 close-out — client hosting credentials: custody ruling + vault widening

Status: PLANNED. Closes `docs/blueprints/webdesk-design-v2.md` §13 OQ-2.6 ("vault choice for
client hosting credentials"). Ground-checked against source on 2026-09-04; every claim below is
either a file:line citation or explicitly marked unverified.

---

## 0 · The finding

**There is no vault to choose. It already exists, and the open question was never "which vault" —
it was "who may we trust it to hold, and what three gaps does it not yet close."**

The vault is `integration_connections`, created by
`platform-nest/migrations/0033_integration_connections.sql`. Its header (lines 1–33) is explicit
that this is a general-purpose, always-on, CORE credential vault — not an OAuth-specific side
table:

> "the AT-REST VAULT for that account's OAuth/API credentials" (line 7) … "every department and
> every future provider reuses it" (line 8).

What it already gives you, cited:

| Property | Where | Detail |
|---|---|---|
| AES-256-GCM at rest | `platform-nest/src/core/secret-box.ts:30,68-82` | `enc:v1:<iv>:<tag>:<data>` envelope, authenticated (tamper-evident), fail-closed 503 on missing/malformed key — never a silent plaintext fallback |
| `enc:v1:` envelope + rotation hook | `secret-box.ts:12-13,26-29,49` and `0033` line 49 | `token_key_version` column exists precisely so a future key can be identified per-row |
| `hasToken`-only reads | `platform-nest/src/core/integrations.service.ts:60-71,92` | The response DTO structurally omits `access_token_enc`/`refresh_token_enc`; only a boolean crosses the API. Enforced by `wsux12-security-gate.test.ts:266` ("ZERO token material — the enc column never serializes") |
| Third-wall RLS | `0033_integration_connections.sql:65-75` | `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `tenant_isolation` policy on `app_current_tenants()` alone (CORE table, no module wall) |
| `owner_kind` already admits `'client'` | `0035_integration_connections_search_providers.sql:43-56`, repaired live by `202608311400_repair_integration_connections_owner_kind_client.sql` | Polymorphic `owner_id -> clients.id`, same convention as `work_activity_links.target_id` |
| `UNIQUE (tenant_id, owner_kind, owner_id, provider)` | `0033:56-58` | One row per (company, owner, provider); a re-link reuses the row rather than accumulating duplicates |

The registry side is equally deliberate. `webdev_sites`
(`platform-nest/migrations/202608300747_webdev_sites_portfolio_registry.sql`) has **no credential
column at all** — only `vault_ref text` (line 79) — and its own comment states why (lines 25–27):
"putting them in the ERP database would be a custody decision made by accident. There is
deliberately no column they could go in." §04 of `webdesk-design-v2.md` restates this as WSK-D30
(line 551): *"the portfolio registry is Zone A only, one row per site/domain, and stores no
credentials — only a `vault_ref`."*

So the actual gap is not schema. It is: (1) nobody has ruled on custody, (2) the vault's provider
CHECK doesn't yet admit hosting-credential kinds, (3) there is no reveal path, no rotation
discipline, and no import off the laptop file. That is the whole build.

---

## 1 · The custody ruling (decision required — not yet made)

**~78 sites are tracked in `webdev_sites`** across our own boxes (delphi, helios), two Hostinger
boxes (one cPanel/WHM VPS, one shared-hosting plan — 68 domains / 52 WordPress installs), a busy
legacy box, and client-owned cPanels. Their hosting credentials currently live in a gitignored
`CREDENTIALS.local.md` on one laptop. Per `../../CLAUDE.md`, `../../platform-nest/CLAUDE.md`: that
file is explicitly the "gitignored local credentials" convention for *this operator's own use* —
it is not, and was never meant to be, a system of record. Nothing above the `tracked` rung of the
§07 adoption ladder is repeatable while it stays that way, because a static-build deploy to a
client cPanel needs a credential a machine can present.

Three options, presented as a decision for the owner:

- **(a) Hold the client's master cPanel/hPanel login.**
  Cheapest to set up — one login, no per-site provisioning. But our DB leak defaces their whole
  account, not one site, and we cannot rotate it without asking the client every time. Every
  breach becomes "we lost the client's password."

- **(b) Hold nothing for client-owned hosts.**
  Safest in the abstract — no blast radius on our side, ever. But every deploy to a client-owned
  host then needs a client-side action (they upload, or they hand us a credential out-of-band
  each time), so adoption above `linked` never automates for that host class. This makes §07's
  "adoption does not require owning the host" claim (`webdesk-design-v2.md:330`) true only in the
  sense that the platform *could* serve such a site — never in the sense that a deploy is
  repeatable without a human on the client's end every time.

- **(c) RECOMMENDED — hold only credentials WE create.**
  A dedicated per-site deploy principal we provision ourselves: an FTP/SSH user, or a WordPress
  application password, scoped to one document root, owned by us end to end. A breach becomes
  "revoke that one user" — never "we lost the client's password" — and rotation needs no client
  involvement because we minted the credential in the first place.

  **What (c) costs:** a one-time per-site setup step (create the scoped user/app-password on the
  client's panel), and it requires `webdev_sites.access` to already be `>= ftp` or `cpanel`
  (`202608300747...sql:57-58` — the `access` CHECK is `none | ftp | cpanel | ssh | full`) — a site
  sitting at `access='none'` cannot have (c) applied until that access is obtained by some other
  means (client hands over panel access once, to let us create the scoped user; after that, (c)
  never touches the master login again).

  **Why (c) is the one that makes §07 operationally true:** it is the only option under which a
  deploy to a client-owned host is a machine action with no client-side step *and* no custody of
  the thing that could deface their whole account. (a) gives you the automation at the cost of
  holding the blast radius; (b) avoids the blast radius at the cost of the automation. (c) is the
  only option that does not trade one for the other.

**This document recommends (c).** The ticket set below (VLT-1…VLT-7) is written assuming (c); if
the owner rules otherwise, VLT-4 (import) and VLT-5 (rotation runbook) are the two tickets that
change shape — everything else (the provider widening, the reveal path, the QA gate) is custody-
model-agnostic and does not need to be re-cut.

---

## 2 · The three real gaps (this is the build)

The vault covers OAuth tokens well. It does not yet cover hosting credentials in three specific
ways:

### Gap 1 — the encryption key lives in an env var on the box

`INTEGRATION_TOKEN_KEY` (`secret-box.ts:37`, `config.ts:307`) is read from process env. A box
compromise that can read env vars can decrypt every sealed row in the table — OAuth tokens today,
hosting credentials tomorrow.

**Verified claim: `token_key_version` rotation is ANTICIPATED, not implemented.** The column is
written (`integrations.service.ts:259,266`, always the constant `TOKEN_KEY_VERSION = "v1"` from
`secret-box.ts:27`), but nothing in `secret-box.ts` **reads** it to select a decryption key —
`decryptSecret()` (`secret-box.ts:87-107`) calls `loadKey()` unconditionally, which resolves the
*single current* `INTEGRATION_TOKEN_KEY`. There is no multi-key lookup, no re-encryption routine,
and no code path that would let a second key version coexist with rows sealed under the first. If
`INTEGRATION_TOKEN_KEY` were rotated today, every existing sealed row would fail its GCM auth-tag
check on the next decrypt attempt — the rotation the column's comment anticipates
(`0033:26`: "so a future OpenBao/KMS key can be rotated in without re-reading plaintext") has no
implementation to carry it out. `secret-box.ts`'s own header (lines 18-21) says this plainly: v1
is "app-layer AES-256-GCM," and OpenBao is "not wired into platform-nest" — "the documented
Phase-2/target-state swap," not a present capability.

This is the one item in this set that could be a genuine blocker, and it is presented as a decision
rather than folded into a ticket:

- **Accept env-key custody explicitly**, recorded in the decision log, for hosting credentials as
  they are for OAuth tokens today. Costs nothing to build; the exposure is "whoever can read the
  box's env can read the vault," which is already true for every OAuth token in the table.
- **Stand up OpenBao first**, then build the actual rotation path (multi-key lookup in
  `secret-box.ts`, a re-encryption job, `token_key_version` finally read instead of only written).
  Costs real engineering — this is not a small ticket — and blocks VLT-4 (import) until it lands,
  if the owner rules that hosting credentials specifically must not ride the env-key model even
  though OAuth tokens already do.

This document does not resolve which; see §5.

### Gap 2 — no human read path, by design, and today that is a real problem

`hasToken`-only reads are correct for the machine-deploy case and correct for OAuth generally —
that discipline is asserted by tests (`wsux12-security-gate.test.ts:266`) precisely because a
plaintext leak through the API is the failure this vault was built to prevent. But a person
sometimes must log into a client's actual cPanel today — to fix something urgent, to verify a
setting, to hand a one-time credential to a subcontractor. There is currently no code path that
returns a hosting credential's plaintext to a human at all; `decryptSecret()` is only ever called
server-side for provider calls (`secret-box.ts:86`: "never used on any read that reaches an API
response").

A deliberate reveal path is needed: Cerbos-gated, WS4-approved (the automation-write execution-
grant pattern — `docs/superpowers/plans/2026-07-14-ws4-automation-flows-plan.md`; the D14
single-use execution grant `platform-nest/src/core/approval-executables.ts`), TTL'd, one audit row
per reveal, and the revealed value never logged and never returned twice for the same grant.

**This is rated the highest-risk ticket in the set.** It is the one place this plan deliberately
opens a path from ciphertext to a human's screen. Every other ticket here either widens a CHECK
constraint or adds a pointer column — this one adds an exfiltration surface with a legitimate use
case, and if the TTL, the single-use grant, or the audit row is wrong, that surface is wide open
with no code-level signal that anything went wrong.

### Gap 3 — no rotation runbook, no last-used/expiry tracking, no import off the laptop file

None of `integration_connections`' existing columns track when a token was last actually used, nor
is there a runbook for rotating a hosting credential specifically (revoke the old deploy user,
mint a new one, re-seal, confirm the old one no longer authenticates). And there is no path today
that takes a row out of `CREDENTIALS.local.md` and puts it in the vault — the file itself, per the
program's own convention (root `CLAUDE.md`: "Credentials live in the gitignored
`CREDENTIALS.local.md`. Never paste a secret into a file, a log, or chat."), is the *personal*
credentials file, and it becomes the shadow system of record for hosting creds specifically unless
something explicitly retires that role for this data class.

The import is necessarily one-time and manual — nobody should write a script that parses a
free-text markdown file as a security control. **The laptop copy of every credential that gets
imported must be deleted from `CREDENTIALS.local.md` after import**, or the laptop is still the
real system of record (with the vault merely a second, unsynchronized copy) and nothing was
gained. That deletion step is an explicit acceptance criterion on VLT-4, not a footnote.

---

## 3 · Ticket set

House style: id · one-line title · tier · dependencies · acceptance criteria that are **observable
probes**, not restated implementation steps.

### VLT-1 — widen `integration_connections.provider` for hosting-credential kinds

- **Tier:** `senior-db`
- **Depends on:** nothing (schema-only, additive)
- **What:** a new timestamp-named migration (reserve the filename per
  `platform-nest/CLAUDE.md`'s numbering rule — do not hardcode a head) that widens the `provider`
  CHECK to add `cpanel`, `ftp`, `ssh`, `wp_admin`, alongside the existing
  `github | google_drive | claude | google_search_console | google_analytics | google_ads |
  semrush`.
- **The one rule that matters more than the SQL:** rebuild the CHECK from the constraint's
  **current live definition** (`pg_get_constraintdef` lookup, exactly as `0035` and
  `202608311000`/`202608311400` do), never from a hardcoded list typed against this ticket's
  understanding of what the table currently allows. `202608311000_integration_connections_
  github_app_owner_kind.sql`'s header (lines 48-63) documents the production incident this
  guards against: a DROP + ADD on this *same table's* `owner_kind` CHECK, written from a
  hardcoded 3-value list, silently deleted the `'client'` value `0035` had added two migrations
  earlier — caught by a test, but only after the uncorrected version had already shipped to LIVE
  (`202608311400`'s repair). `provider`'s CHECK has exactly the same shape of risk: it has been
  widened twice already (`0033` → 3 values, `0035` → 7 values) and a naive rebuild here would
  silently drop `google_search_console`/`google_analytics`/`google_ads`/`semrush` for every
  future write.
- **Acceptance criteria (observable):**
  1. A test (mirroring `src/db/module-search-rls.test.ts`'s "integration_connections widen is
     additive" case) asserts that **every value permitted before this migration is still
     permitted after it** — read from `pg_get_constraintdef` post-migration, not from the
     migration's own SQL text. This test must exist as a standing regression guard, not a one-time
     manual check, because it is exactly the test that caught the `owner_kind` regression.
  2. A second test inserts a row with each of the four new provider values and asserts success;
     inserting `provider = 'anything-else'` still fails the CHECK.
  3. The migration's own header cites the `202608311000`/`202608311400` incident and states the
     rule in its own words (repo convention — every migration touching a shared CHECK on this
     table has, so far, restated the lesson rather than only linking to it).
  4. `owner_kind` is confirmed unchanged — it already admits `'client'` (`0035`, repaired live by
     `202608311400`) — and this ticket does **not** touch it. A probe query against LIVE (or the
     migration's own DO-block self-check, following `202608311400`'s pattern at lines 51-70)
     confirms all four existing `owner_kind` values are still present after this migration runs.

### VLT-2 — `vault_ref` wiring on `webdev_sites` (pointer only)

- **Tier:** `senior-be`
- **Depends on:** VLT-1 (a hosting connection needs somewhere to point *to* before a site can point
  *at* it, though the two could theoretically land in either order — sequencing is for review
  clarity, not a hard technical block)
- **What:** `webdev_sites.vault_ref` (`202608300747...sql:79`) exists but nothing reads or writes
  it today — confirmed by reading `platform-nest/src/modules/webdev/portfolio-reads.service.ts`
  (the site read model, lines 18-48): its `PortfolioSite` DTO has no `vaultRef` field, and a repo
  search for `INSERT INTO webdev_sites` / `UPDATE webdev_sites` in `platform-nest/src` finds only
  direct test SQL (`github-repos-http.test.ts:71`, `db/github-repos-rls.test.ts:70`,
  `portfolio-reads.service.test.ts:31`) — **there is no HTTP write path for this table at all
  yet**, hosting or otherwise. This ticket adds: (1) `vaultRef` on the read DTO, populated from the
  column; (2) a scoped write path (PATCH, tenant + capability gated) that accepts `vaultRef` as an
  `integration_connections.id` (or null to clear it) and nothing else.
- **The invariant this must not regress (WSK-D30):** the registry stores a pointer, never a
  secret. `202608300747...sql`'s own comment (lines 25-27, 122-125) is explicit that this is a
  *deliberate* absence, not an oversight — "there is deliberately no column they could go in."
- **Acceptance criteria (observable):**
  1. A test asserts `webdev_sites`' full column list contains no column whose name matches
     `/token|secret|password|credential/i` — a regression guard that fails loudly if a future
     change (this ticket or any other) adds one, rather than relying on code review to notice.
  2. A test PATCHes `vaultRef` to a value that is not a valid `integration_connections.id` in the
     same tenant and asserts the write is rejected (FK-equivalent validation — `vault_ref` has no
     literal FK per the table's design, so this must be enforced in the service layer, and the
     test is what proves the enforcement exists rather than assuming it).
  3. A test asserts the PATCH endpoint accepts `vaultRef` and rejects any other unrecognized field
     in the same payload (proves the endpoint cannot become a backdoor write path for other
     columns, including a future accidental credential column).
  4. RLS/tenancy: a cross-tenant PATCH attempt (valid `vault_ref` value, wrong tenant's site row)
     is denied — reuses `webdev_sites`' existing `tenant_isolation` policy
     (`202608300747...sql:106-108`), proven by a test that attempts it and asserts 403/404, not
     merely asserted from the policy's existence.

### VLT-3 — the reveal path (highest risk in this set)

- **Tier:** `senior-be` — **flag for opus-tier review**: this is the one ticket in the set that
  opens a ciphertext-to-plaintext-to-human path on a credential vault; a design mistake here
  (TTL, single-use, audit, or logging) is a live exfiltration surface, not a functional bug, and it
  deserves a reviewer working at the highest available reasoning tier before it ships.
- **Depends on:** VLT-1 (there must be hosting-credential rows to reveal)
- **What:** a new Cerbos action on the **existing** `integration_connection` resource kind — no new
  kind is required (see §4 below for why). Proposed action name `reveal` (mirroring the `manage`
  precedent — `202608230730_iam14c_integration_connection_manage.sql` added a company-wide
  `manage` action onto this exact kind, additively, without touching the four existing
  read/create/update/delete rules). `reveal`:
  - requires a live, unexpired, single-use D14 execution grant
    (`platform-nest/src/core/approval-executables.ts`) minted through the WS4 approval flow — no
    self-approval path;
  - decrypts via `secret-box.ts`'s existing `decryptSecret()` (no new crypto);
  - returns the plaintext exactly once for that grant — a second call with the same (spent) grant
    is denied, not merely re-served;
  - writes exactly one audit row per successful reveal (who, when, which connection, which grant),
    and the plaintext value itself is asserted absent from every log line the reveal path touches;
  - the grant carries a short TTL (proposed default: 15 minutes — see §5 for why this is an open
    item, not a locked number).
- **Acceptance criteria (observable):**
  1. A test calls reveal without a D14 grant and asserts denial (403/401, Cerbos decision `DENY`
     — not merely "the endpoint didn't exist yet").
  2. A test mints a valid grant, reveals successfully, then attempts a second reveal on the **same
     grant** and asserts denial — proving single-use is enforced server-side, not merely
     client-side convention.
  3. A test mints a grant, lets its TTL expire (fake clock or a sub-second TTL in test config),
     attempts reveal, asserts denial.
  4. A test greps the full request/response log and application log output of a successful reveal
     call for the plaintext value and asserts zero matches — mirroring the discipline
     `wsux12-security-gate.test.ts` already applies to `hasToken`, but for the plaintext path
     instead of the never-serialize path.
  5. A test asserts exactly one audit row is written per successful reveal, with no audit row on a
     denied attempt masquerading as a successful one (i.e., the audit table's row count is the
     ground truth for "how many times was this credential exposed to a human," which is the whole
     point of building this path at all instead of leaving it undecryptable).

### VLT-4 — import off `CREDENTIALS.local.md`

- **Tier:** `medior` (one-time script; not architecturally hard, but security-sensitive in
  handling)
- **Depends on:** VLT-1, VLT-2, and the custody ruling in §1 (option (c) assumed; if the owner
  rules (a) or (b) instead, this ticket's shape changes — see §1's closing note)
- **What:** a one-time, manually-run import script that, for each site currently tracked only in
  the laptop file: creates (or confirms) the scoped deploy credential per (c), creates an
  `integration_connections` row via `setConnectionTokens` (the existing, tested vault-write path —
  `integrations.service.ts:249`), and sets that row's id as the corresponding `webdev_sites.
  vault_ref` via VLT-2's write path. **Never** parses the markdown file as a trusted data source —
  a human reads each entry and drives the script per-row.
- **Acceptance criteria (observable):**
  1. After the script runs for a given site, `integrations.service`'s existing `hasToken` read for
     that connection returns `true`, and a direct DB check confirms the stored value is `enc:v1:`-
     prefixed ciphertext, never plaintext (reuses the exact assertion `integrations.test.ts:137-144`
     already makes for OAuth tokens).
  2. `webdev_sites.vault_ref` for that site resolves to a connection row in the **same tenant**
     (cross-tenant `vault_ref` is rejected by VLT-2's validation, so this is really re-confirming
     VLT-2 held under real data, not new logic).
  3. **Process checklist, not code** — but still an acceptance criterion: the runbook this ticket
     produces states, in an explicit numbered step, "delete this row from `CREDENTIALS.local.md`
     now" immediately after each successful import, and the ticket is not considered
     DEV-VERIFIED until a human confirms the file's line count for imported entries is zero.
     Skipping this step means the laptop is still the system of record and the ticket has not
     actually closed OQ-2.6's stated problem.

### VLT-5 — rotation runbook

- **Tier:** `junior` (documentation-led; the only code is a thin CLI or admin-console action, not
  new server logic)
- **Depends on:** VLT-1, VLT-3 (rotation needs a way to confirm the *old* credential still works
  before revoking it, which for a human-driven rotation is the reveal path)
- **What:** a runbook (`platform-nest`'s `docs/runbooks/` per existing convention, or this
  program's `infra/runbooks/` if it is cross-cutting) covering: mint a new scoped deploy credential
  on the target host, `setConnectionTokens` to reseal the `integration_connections` row under the
  new value, confirm a real deploy succeeds with the new credential, revoke the old credential on
  the host. No automatic scheduled rotation in this ticket — that is future work, named explicitly
  in §6.
- **Acceptance criteria (observable):** a rotation is actually driven end-to-end against one real
  or realistic test site by a human following only the runbook (no undocumented steps supplied
  verbally), and the OLD credential is confirmed (by attempting to use it) to no longer
  authenticate afterward. A runbook nobody has executed is not DEV-VERIFIED.

### VLT-6 — last-used / expiry tracking

- **Tier:** `senior-db` (schema) + `medior` (wiring the write)
- **Depends on:** VLT-1
- **What:** a migration adding `last_used_at timestamptz` to `integration_connections` (additive,
  nullable — existing OAuth rows get no backfill value, which is an honest NULL, not a false
  measurement), and a write in the reveal path (VLT-3) and in whatever server-side deploy code
  later consumes a hosting credential, stamping `last_used_at = now()` on use. `token_expires_at`
  already exists (`0033:48`) and is reused as-is for credential classes that have a real
  expiry (e.g., a WP application password with a set lifetime); hosting credentials with no
  natural expiry leave it NULL.
- **Acceptance criteria (observable):**
  1. A test performs a reveal (VLT-3) and asserts `last_used_at` moved forward on that row and on
     no other row in the same tenant.
  2. A test asserts a freshly-imported (VLT-4) row has `last_used_at IS NULL` until first use —
     NULL is the honest "never used," not a synthetic timestamp.
  3. A query (documented, not necessarily a new endpoint in this ticket) can list every hosting
     connection whose `last_used_at` is NULL or older than N days — the actual operational question
     this data exists to answer — and a test proves that query returns the right set against
     fixture rows spanning "never used," "used yesterday," and "used a year ago."

### VLT-7 — QA gate

- **Tier:** `qa`
- **Depends on:** VLT-1 through VLT-6
- **What:** an end-to-end pass across the whole set, driven against the real surfaces (per this
  program's standing rule that scripted/cross-process verification is not real-input verification):
  import a fixture hosting credential (VLT-4) → confirm `vault_ref` resolves (VLT-2) → attempt
  reveal without a grant (denied) → mint a grant, reveal once (succeeds), reveal again on the same
  grant (denied) → let a short-TTL grant expire and reveal (denied) → confirm `last_used_at` moved
  (VLT-6) → run the rotation runbook (VLT-5) against the same fixture and confirm the old
  credential stops working → confirm the CHECK-widening regression guard (VLT-1's additive test)
  is green.
- **Acceptance criteria (observable):** a written run log naming each step above with pass/fail,
  not a bare "tests green" — because the recurring failure mode this program has already hit
  (`green-suite-misses-server-only-violation.md`, per the user's own memory index) is a green unit
  suite sitting in front of a broken live path. This gate exists specifically to drive the reveal
  endpoint and the rotation runbook as a human would, not only as vitest would.

---

## 4 · Does this need a new Cerbos resource kind? No — and here is the measurement, not an assumption

`integration_connection` is an **existing** Cerbos kind (`platform-nest/cerbos/policies/
resource_integration_connection.yaml`), already carrying five actions (`read`, `create`, `update`,
`delete`, `manage`) across role-arm and permission-arm rules. VLT-3's `reveal` action is a **sixth
action on the same kind**, not a new kind, and the precedent for exactly this shape of change
already shipped: `202608230730_iam14c_integration_connection_manage.sql` added `manage` onto this
identical kind without touching `platform-nest/src/rbac/cerbos.ts`'s `Resource` type/allow-list
(the resource attributes — `kind`, `tenantId`, `id`, `ownerId` — are unchanged; only a new
permitted *action* string is added) and without touching `scripts/generate-role-bundles.mjs`'s
kind-to-department resolvers (those map **kinds**, not individual actions, to roles).

A genuinely new resource kind is a six-artifact change in this codebase — measured, not asserted,
against the last one added (`resource_github_repo.yaml`, 2026-08-31): (1) the policy YAML itself,
(2) `platform-nest/src/rbac/cerbos.ts`'s `Resource` type + `resourcePayload()` allow-list, (3)
`permission-catalog.json`, (4) `permission-groups.json`, (5) a migration seeding
`permissions`/`role_permissions` with an `owner`-mirrors-`company_admin` self-check, and (6)
`scripts/generate-role-bundles.mjs` + `role-permission-parity.db.test.ts`'s two independent
resolvers — plus **four pinned count literals** that break until updated:
`iam-215-boundary-pin.test.ts`, `permission-groups-catalog-parity.test.ts`,
`ui-grantable-catalog.test.ts`, `cerbos-catalog-alignment.test.ts`. **None of this applies here.**
This set reuses an existing kind.

What VLT-3 *does* still have to account for: `cerbos-catalog-alignment.test.ts:120` pins the total
permission-catalog length as a literal — `expect(catalog.length).toBe(396)` — while the *kind
count* is pinned separately at line 121 (`catalogKindSet.size).toBe(97)`) and is unaffected by
adding an action to an existing kind. Minting the one new `core.integration_connection.reveal`
permission key (VLT-3) will bump the catalog length by one and that literal (currently `396`) will
need updating in the same change — a one-line diff, not a new artifact class, and explicitly listed
as part of VLT-3's own acceptance work, not a surprise for review to catch.

---

## 5 · What this does NOT do

- **Does not stand up OpenBao or any KMS.** Gap 1 (§2) is presented as a decision, not built here;
  if the owner rules that hosting credentials must not ride the env-key model, that is a separate,
  larger ticket this document explicitly does not spec.
- **Does not build scheduled/automatic credential rotation.** VLT-5 is a human-driven runbook.
  Scheduled rotation (e.g., "rotate every 90 days automatically") is named as future work in §6,
  not built.
- **Does not build a client-facing credential management UI.** Everything here is staff/ops-side.
  A client never sees, sets, or manages a hosting credential through this set.
- **Does not change how OAuth tokens (github/google/claude/search-provider) are stored, read, or
  rotated.** Their path through `integration_connections` is unchanged; this set only widens the
  `provider` CHECK to admit new *values*.
- **Does not touch `owner_kind`.** It already admits `'client'` (0035, repaired live by
  202608311400) and this set's provider widening does not need to reopen it. Anyone extending this
  work who *does* need to touch `owner_kind` must re-read `202608311000`'s and `202608311400`'s
  headers first — see VLT-1's acceptance criteria for why.
- **Does not create a new Cerbos resource kind.** See §4.
- **Does not deploy anything to a client host.** This is the credential layer only — the actual
  deploy automation (an FTP/SSH/WP-REST push driven by a `webdev_sites` row + its `vault_ref`) is a
  separate, later piece of work that this vault makes *possible*, not something this ticket set
  builds.
- **Does not resolve which of (a)/(b)/(c) the owner actually wants.** §1 is a recommendation, not
  a ruling — the ruling is the owner's, and VLT-4/VLT-5 are written assuming (c) is chosen.
- **Does not retroactively audit whether `CREDENTIALS.local.md` has already leaked** (e.g., via a
  synced backup, a screen share, a git-add mistake on a differently-configured machine). That is a
  separate incident-response question, out of scope here.

---

## 6 · Open items remaining after this set lands

Following §13's convention — each item names a default if nobody answers it.

| # | Question | Default if unanswered |
|---|---|---|
| OQ-2.6.a | Which custody model — (a) master login, (b) hold nothing, (c) our-own-principal (recommended) | **Blocked** — VLT-4 (import) does not run until this is ruled; nothing moves off the laptop file |
| ~~OQ-2.6.b~~ | Accept env-key custody (`INTEGRATION_TOKEN_KEY`) for hosting credentials explicitly, or require OpenBao first | **RULED 2026-09-04 (owner: "use the current keys for now") — env-key custody ACCEPTED; OpenBao is not a precondition.** Recorded as **WSK-D33** in `webdesk-design-v2.md` §14. **Read with the defect it does not fix:** rotation is unimplemented (§2 Gap 1), so this is a decision to *not rotate*, not a finding that rotation is safe — a DO-NOT-ROTATE tripwire is a precondition of VLT-4. |
| OQ-2.6.c | Reveal grant TTL and whether WS4 approval may ever be self-granted for a break-glass case | **15 minutes, never self-granted** — a break-glass path, if wanted, is a separate future ticket with its own audit story, not a quiet exception inside VLT-3 |
| OQ-2.6.d | Scheduled/automatic rotation cadence (vs. VLT-5's manual-only runbook) | **Manual only, on suspected compromise or client offboarding** — no calendar-driven rotation until a dedicated ticket builds it |
| OQ-2.6.e | Whether `last_used_at` staleness (VLT-6) should ever page/alert automatically | **No alerting** — the query exists for a human to run; wiring it into the existing monitoring stack (per `monitoring-live-and-its-traps` conventions) is separate future work |

---

## Appendix — files read for this plan

- `platform-nest/migrations/0033_integration_connections.sql`
- `platform-nest/migrations/0035_integration_connections_search_providers.sql`
- `platform-nest/migrations/202608311000_integration_connections_github_app_owner_kind.sql`
- `platform-nest/migrations/202608311400_repair_integration_connections_owner_kind_client.sql`
- `platform-nest/migrations/202608300747_webdev_sites_portfolio_registry.sql`
- `platform-nest/migrations/202608230730_iam14c_integration_connection_manage.sql`
- `platform-nest/src/core/secret-box.ts`
- `platform-nest/src/core/integrations.service.ts`
- `platform-nest/src/core/integrations.test.ts`
- `platform-nest/src/core/wsux12-security-gate.test.ts`
- `platform-nest/src/config.ts` (lines 295-310)
- `platform-nest/cerbos/policies/resource_integration_connection.yaml`
- `platform-nest/src/rbac/cerbos-catalog-alignment.test.ts` (pinned literals, lines 120-121)
- `platform-nest/src/modules/webdev/portfolio-reads.service.ts`
- `docs/blueprints/webdesk-design-v2.md` §04, §07, §13, §14 (WSK-D30)
