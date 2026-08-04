# Client Portal (CP-*) — deployment plan & runbook

**Status:** DEV-VERIFIED (local, no live stack) · **Target:** `gda-aicenter` → https://erp.gaiada.online
**Date:** 2026-08-04 · **Owner decision it implements:** the client side is a SEPARATE INTERFACE from
the employee ERP (2026-08-04).

Vocabulary per `docs/modules/MODULES.md`: **PLANNED · IN PROGRESS · PROTOTYPED · DEV-VERIFIED**.
Nothing here is "production" or "done".

---

## 1 · What ships

| Piece | Where | Status |
|---|---|---|
| Migration `0075_client_portal.sql` — `contracts`, `contract_signatures`, `invoice_payments` | `platform-nest/migrations/` | DEV-VERIFIED (tsc + lint; **DB apply UNVERIFIED locally**) |
| Portal scope kernel (`portal-scope.ts`) + 2 closed IDOR gaps | `platform-nest/src/core/` | DEV-VERIFIED |
| Portal BFF: workspace / commerce / profile / stream (4 controllers, ~20 routes) | `platform-nest/src/core/portal-*.controller.ts` | DEV-VERIFIED (tsc) |
| Staff counterpart: contract authoring + payment confirmation | `platform-nest/src/core/contracts.controller.ts` | DEV-VERIFIED (tsc) |
| SSE live bus (`portal-live.service.ts`) | `platform-nest/src/core/` | DEV-VERIFIED (9 unit tests green) |
| Cerbos: `resource_portal.yaml` (+2 actions), **new** `resource_contract.yaml` | `platform-nest/cerbos/policies/` | DEV-VERIFIED (schema-valid) |
| `(portal)` route group — 11 routes, own shell/nav/theme | `platform-ui/src/app/(portal)/` | DEV-VERIFIED (build + 6 e2e green) |
| nginx SSE location block | `infra/nginx/erp.gaiada.online.conf` | PROTOTYPED (not yet applied to the box) |
| `deploy.yml`: explicit Cerbos policy reload step | `.github/workflows/deploy.yml` | PROTOTYPED (never executed) |

**No new environment variables and no compose changes.** The portal reuses `REDIS_URL`,
`PLATFORM_URL` and `PLATFORM_SERVICE_TOKEN`, all already wired. This is deliberate: the
`compose-env-passthrough-trap` has shipped four features silently disabled, and adding a var to
`.env` without listing it in the service's `environment:` block is invisible. Nothing to forget here.

---

## 2 · Deploy sequence

The pipeline already does all of this (`git push --tags` → `release.yml` → `deploy.yml`). Listed so the
order is auditable, not because any step is manual.

1. **Verify signatures** → **BACKUP** (the gate for migrations) → **pull** → **migrate** → **up** →
   **reload Cerbos** → **health**.
2. **Migrations.** The box is at **0074** after the last cut; this adds **0075**. One file, pure DDL,
   no backfill DML — so the `migration-backfill-rls-trap` (owner lacks `BYPASSRLS`, unset tenant GUC ⇒
   backfill silently affects zero rows) **does not apply**. Verify after: `SELECT count(*) FROM
   schema_migrations` should be **71**.

   **It touches four EXISTING tables**, which is the only part of this migration with an operational
   cost. `0075 §0` adds `UNIQUE (id, tenant_id)` to `clients`, `projects`, `invoices` and `files` so the
   new tables can carry **tenant-scoped composite foreign keys** — the `0027` pattern. A plain
   `REFERENCES parent(id)` on a tenant-scoped parent proves only that the id exists *somewhere*
   (Postgres enforces FKs through a system trigger that ignores row security), so a row could carry
   tenant A's `tenant_id` while pointing at tenant B's parent, invisibly. These are the money and
   signed-agreement tables, so the composite form is worth it here even though `0072` — the closest
   analogue, three days earlier — used plain FKs. `0072`'s are deliberately **not** retrofitted; that is
   a separate migration against live rows.

   Each `ADD CONSTRAINT` builds an index and takes a brief `ACCESS EXCLUSIVE` lock on the table. At the
   current data volume (a handful of clients, projects and invoices) this is milliseconds. On a large
   `files` table it would not be — worth re-checking `SELECT count(*) FROM files` before a much later
   replay of this migration on a bigger database.
3. **Cerbos reload — the step that was added for this release.** `resource_contract.yaml` is a **NEW
   POLICY FILE**, and a new file has been observed NOT to be hot-reloaded through a bind mount even
   with `watchForChanges: true`. An unloaded policy is not an error anywhere: Cerbos keeps serving the
   old repo, an unknown resource kind is **DENIED**, and every contract endpoint 403s for every user
   while the logs look healthy. `deploy.yml` now runs `docker compose restart cerbos` after `up -d` and
   before the health gate, so a policy repo that fails to parse fails the deploy instead of silently
   denying in production.
4. **nginx.** Apply the new `location = /api/portal/stream` block, then `nginx -t && systemctl reload
   nginx`. The stream WORKS without it (the endpoint sends `X-Accel-Buffering: no`, which nginx
   honours) — the block exists for the two things the app cannot set: `proxy_read_timeout` (the default
   60s leaves only one missed 25s heartbeat of margin) and clearing the `Connection: upgrade` header
   that `location /` hardcodes for Next.
5. **Seeds.** Not part of deploy, and the portal is empty without them — see §4.

### Rollback
Forward-only schema, as always. `0075` adds three tables and touches nothing existing, so re-pinning
the previous tag leaves them orphaned and harmless — the previous image simply never queries them.
Note the known open issue: **rollback is broken for any release that ADDS a service.** This release
adds none, so that path is unaffected.

---

## 3 · Post-deploy verification (in order; each one has failed for someone before)

```bash
# 1 · schema
ssh gda-aicenter "psql \$MIGRATE_DATABASE_URL -c \"select count(*) from schema_migrations\""   # 71
ssh gda-aicenter "psql \$MIGRATE_DATABASE_URL -c '\\d contracts'"                              # exists

# 2 · version parity — /health LIES after a failed deploy (deploy-rollback-version-bug).
#     Trust docker inspect, not /health.
ssh gda-aicenter "docker inspect --format '{{index .Config.Labels \"org.opencontainers.image.version\"}}' gaiada-platform-1"

# 3 · Cerbos actually loaded the new policy. A 200 here and a 403 on /contracts means the
#     restart did not take.
curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $TOKEN" \
  https://erp.gaiada.online/api/$TENANT/contracts        # 200 for a company_admin, NOT 403

# 4 · the portal answers for a CLIENT and refuses for staff
curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $CLIENT_TOKEN" \
  https://erp.gaiada.online/api/$TENANT/portal/overview  # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $STAFF_TOKEN" \
  https://erp.gaiada.online/api/$TENANT/portal/overview  # 403 "not a portal client"

# 5 · SSE is genuinely streaming and not buffered. The `hello` frame must arrive IMMEDIATELY.
#     If this hangs and then dumps everything at once, nginx is buffering.
curl -N -s --max-time 8 -H "authorization: Bearer $CLIENT_TOKEN" \
  https://erp.gaiada.online/api/$TENANT/portal/stream | head -5
#   expect: retry: 5000 / event: hello / data: {"mode":"live",...}
#   `"mode":"poll"` means REDIS_URL is unset or Redis is unreachable — the portal still works
#   (it polls) but realtime is off, and this is the only place that says so.

# 6 · the UI, as a client, in a browser: /portal must render the PORTAL shell (no staff sidebar,
#     no company switcher, no departments rail).
```

A **200 is not a pass** (`missing-field-reads-as-null`): check the body. In particular
`/portal/overview` returning `{"clients":[]}` with a 200 means the caller resolved as a client but has
no `client_contacts` row — a seeding problem, not an auth problem.

---

## 4 · Seeding — the portal is EMPTY without this

The portal renders from real records, so a fresh box shows a working portal with nothing in it. To
drive it end to end on the server:

1. **A client contact.** `client_contacts` (0072) is what resolves portal ownership. Create via the
   staff invite flow (`POST /api/:t/clients/:id/contacts` → magic link → accept) or directly:
   ```sql
   INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, activated_at, origin_site)
   VALUES (gen_random_uuid(), :tenant, :client, :user, 'signer', 'active', now(), 'central');
   ```
   The user also needs the global `client` role (`user_roles`) or `principal.companies` will not
   include the tenant and Cerbos's `inTenant` will be false.
2. **A contract to sign:** `POST /api/:t/contracts` (draft) → attach terms → `POST
   /api/:t/contracts/:id/send`. It will not send without a document or `bodyMd` — deliberately, since
   the portal refuses to render a sign form over empty terms.
3. **An invoice to pay:** the existing billing flow. Note `BillingController` is gated by
   `ModuleEnabledGuard("billing")`, so the `billing` module must be enabled for the tenant to CREATE
   one — but the portal's invoice READS are deliberately not module-gated, so a client keeps seeing
   invoices even if the module is later switched off.
4. **Countersign / confirm:** `POST /contracts/:id/countersign` (owner-only) and `POST
   /invoice-payments/:id/decide`. The confirmer must differ from the recorder — the route refuses
   self-confirmation.

---

## 5 · What is NOT in this release (explicit deferrals)

| Deferred | Why, and what it costs today |
|---|---|
| **Staff UI for contracts** | The endpoints exist and are tested; there is no page. Contracts must be created via API until a `/clients/[id]/contracts` surface is built. The client side is fully usable once a contract exists. |
| **Staff UI for payment confirmation** | Same: `GET /invoice-payments?status=pending` is the finance queue, with no page on it yet. **A client-recorded payment sits `pending` until someone calls the decide endpoint** — so if this ships before the UI, whoever owns finance needs to know the endpoint exists. |
| **Email/WhatsApp notification of portal events** | In-app notifications are wired (the bell, `notifications`). Outbound email is not — a client who does not visit the portal is not told a contract is waiting. The `notifyBestEffort` call sites are where that hooks in. |
| **PDF generation for contracts** | A contract carries an attached `file_id`; nothing generates one from `bodyMd`. The `report-renderer` sidecar already renders HTML→PDF and is the obvious seam. |
| **Online payment gateway** | Decided against for v1 (bank transfer + proof upload instead). `invoice_payments.method` already admits `card`, so a gateway becomes a new confirmation source rather than a schema change. |
| **Per-company portal branding** | The shell is hard-coded to the Syrowatka mark. `clients.tenant_id → companies` is where a per-tenant logo would come from. |
| **A separate subdomain / separate Next app** | Decided: route group now. Moving `(portal)/` to its own app later is mechanical — it shares only `platformFetch`, the session cookie and the token layer. |

---

## 6 · Traps specific to this release

1. **`(app)/portal/*` was DELETED, not left in place.** Two route groups cannot both serve `/portal`;
   Next fails the build on the collision. The old `/portal/[runId]` moved to
   `/portal/approvals/[runId]`. **Any stored notification `href` pointing at `/portal/<runId>` is now
   a 404** — the pipeline's own notifications use `/pipeline/:runId` (staff-side) so this is believed
   to affect nothing live, but it is worth one query against `notifications` before the cut:
   ```sql
   SELECT count(*) FROM notifications WHERE payload->>'href' ~ '^/portal/[0-9a-f]{8}-';
   ```
2. **The SSE endpoint holds a connection per open portal tab.** Each costs one subscriber and one
   heartbeat timer, capped by a 30-minute server-side rotation. With a handful of clients this is
   nothing; it is listed because it is the first long-lived connection this platform serves to
   external parties.
3. **`portal-stream-server.ts` duplicates `platformFetch`'s auth-resolution order** (OIDC token first,
   dev service-token second) because `platformFetch` parses JSON and would hang on a stream. If that
   order ever changes in `platform.ts`, it must change in both. Flagged in the file itself.
4. **Redis absent ⇒ `mode: "poll"`, silently.** The portal keeps working. This is correct behaviour and
   also exactly the "fails closed means silently does nothing" pattern that has bitten twice
   (`N8N_BRIDGE_ENTITY_TYPES`). §3 step 5 is the check that makes it visible.
5. **A `viewer` contact cannot sign — and that is newly ENFORCED.** `client_contacts.capability`
   existed since 0072 and nothing read it: every invited stakeholder could countersign a scope
   agreement. It is now enforced on both signing paths. If anyone was relying on the old behaviour,
   their signature attempts will start returning 403 "your access is view-only".

---

## 7 · Verification actually performed (2026-08-04)

**Green, locally:**
- `platform-nest`: `tsc --noEmit` clean; `portal-live.test.ts` **9/9**.
- `platform-ui`: `tsc --noEmit` clean; `DEMO_MODE=1 npm run build` green (all **11** portal routes
  emitted); `npm test` **1040/1040** across 102 files (43 of them new); `playwright --project=portal`
  **6/6** — shell swap, all 8 tabs, contract signing, payment recording, staff teach-state.
- `docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml config` parses with no
  mandatory var missing (the real deploy combination).

**UNVERIFIED — and why:**
- `portal-dashboard.test.ts` (25 DB-backed isolation/capability cases) is **written and typechecked
  but never executed**: the local Postgres/Cerbos pair is deliberately off on this machine (owner
  decision — the server is the source of truth). It runs in CI, which provisions PG + migrations +
  Cerbos. **Treat every DB-level claim in this document as unverified until that CI job is green.**
- **Migration `0075` has not been applied to any database, and could not be.** Both routes to
  validating it locally are closed: no Postgres is running (owner decision), and the Docker daemon is
  down on this machine, so a throwaway `postgres:15` container to run the real migrator against was not
  an option either. It has been hand-reviewed for statement ORDER (the composite unique on `contracts`
  must precede both the self-FK and `contract_signatures`, and it does) and for `MATCH SIMPLE`
  semantics (a NULL `project_id`/`client_id`/`proof_file_id` correctly skips its composite FK check),
  but **hand-review is not execution.** The CI job that provisions Postgres is the first real test of
  this file; treat a green run of it as the gate, and expect the composite FKs to be where a mistake
  would surface.
- The nginx block and the `deploy.yml` Cerbos step have not been executed anywhere.
