# Agency First-Deploy Readiness Checklist (Phase 5c)

> Go/no-go for shipping the **digital-agency child company** on the platform. "Code" items are
> done and test-verified in this repo; "Infra/ops" and "Legal" items are the human-gated
> prerequisites before real client/employee data is ingested.

## What the agency can do at first deploy (all CODE-COMPLETE, test-verified)
Proven end-to-end by `platform/src/agency-first-deploy.e2e.test.ts` (one tenant, full role
spread, the real API path), on top of the per-feature suites (81 platform tests):

- [x] **Clients** — onboard/list/update external customers the agency bills (`/:t/clients`).
- [x] **Projects** — client-linked or internal, custom fields validated on write.
- [x] **Campaigns** — agency module, on a core project (`/:t/modules/agency/campaigns`).
- [x] **Briefs** — campaign requirements (`…/campaigns/:id/briefs`).
- [x] **Creative assets + review** — submit → approval raised → client-lead approves →
      asset review-state flips; requester notified.
- [x] **Deliverables** — billable work owed to a client, due dates (`/:t/deliverables`).
- [x] **Tasks** — create/detail/update; assignment notifies the assignee.
- [x] **Time entries** — billable minutes, owned by the logger (`/:t/time-entries`).
- [x] **Comments + notifications** — threaded comments; mention / assignment /
      comment-on-assigned / approval-decided notifications; per-user inbox.
- [x] **Files/attachments** — upload (day-one PII scrub on text), download (attachment +
      nosniff + CSP sandbox), list, delete; IDOR-guarded against the target entity.
- [x] **Custom fields (D17)** — define per entity; UI reads defs to render forms.
- [x] **Management view (D12)** — cross-company rollups the group exec reads:
      `agency.campaigns.active`, `agency.approvals.pending`, `agency.assets.in_review`,
      `agency.utilization` (billable ÷ capacity, num/den), `agency.deliverables.due_week`,
      `core.time.billable_minutes`, `core.deliverables.open`, task status/open-ratio.
- [x] **Authz everywhere** — Cerbos policies for every resource kind; RLS on the
      authorized-tenant-set; low-assurance sessions get no company data.

## Seed
- [x] `npm run seed:agency` (platform) — idempotent; creates the **Gaiada Creative** tenant
      with owner/PM/designer/copy/client-lead + group-exec, two clients, client-linked
      projects, a live campaign (briefs + assets, one in review), deliverables due this week,
      assigned tasks, and billable time. Safe to re-run.

## Infra / ops prerequisites (human-gated — NOT code)
- [ ] Postgres reachable; migrations applied (`npm run migrate`) as a **NOBYPASSRLS** app role.
- [ ] **Cerbos** deployed and reachable at `CERBOS_URL`, policies mounted from
      `platform/cerbos/policies` (18 policies). NOTE: publish the container's ports
      (`-p 3592:3592 -p 3593:3593`) — a portless container is why local runs failed once.
- [ ] Keycloak (OIDC) up; `AUTH_MODE=oidc`, issuer/JWKS/audience set (dev uses `x-user-id`).
- [ ] `FILES_DIR` points at a persistent, backed-up volume (local-first store).
- [ ] `PLATFORM_SERVICE_TOKEN` set (bot/hub/n8n/BFF present it); rotate off the dev default.
- [ ] platform-ui: session/IdP wired (HMAC dev-login is the interim).

## Legal / data gates (do NOT ingest real data until green)
- [ ] Legal **Gate 1** (DPIA/LIA/notices reviewed) — no real employee/client PII before this.
- [ ] Day-one technical gate: scrub + crypto-shred paths confirmed on the target env.

## Deferred (explicitly NOT first-deploy blocking)
NestJS port · event backbone · sync engine · Go realtime hub · resort/marine/printing
verticals · multipart/large-file upload (base64 path ships now, 25 MiB ceiling) ·
per-notification email/push fan-out (in-app inbox ships now).
