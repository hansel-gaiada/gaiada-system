# Gaiada ERP UI — Plan 2: Business Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the business-data pages to the Gaiada ERP UI — Companies, Projects, Tasks, Agency, and Rollups — with list views, detail views, and create/edit forms that render D17 custom fields, backed by the platform detail/update/custom-field endpoints they require.

**Architecture:** The platform (`platform/`, Fastify+PG on 3004) gains read-detail, update (PATCH), members-list, custom-field-definitions, and agency-brief endpoints. The UI (`platform-ui/`, Next.js BFF on 3005) adds a shared entities data layer + reusable page/detail/form primitives, then one route area per module. Every page is a server component fetching through the platform (which mints the principal and enforces RBAC/RLS); writes go through server actions that revalidate. Custom fields (D17) are rendered dynamically from field definitions the platform returns.

**Tech Stack:** Platform: Fastify, Postgres (FORCE RLS), vitest on live PG. UI: Next.js 15 App Router, React 19, plain CSS design tokens, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-05-gaiada-erp-ui-design.md` (approved). This plan covers spec §5 rows Companies/Projects/Tasks/Agency/Rollups and spec §9 stage 3. Plans 1 (foundation) is complete; plans 3–5 (admin APIs+Systems pages, admin section+step-up, polish) follow.

---

> ## SCOPE REVISION (2026-07-05) — UI-ONLY SESSION
>
> Per user direction: **this is a UI/UX session; all backend/platform work belongs to a concurrent session, and the UI must follow the backend that session provides.** Therefore:
>
> - **Backend Tasks 1–3 are NOT done here.** Task 1 (project detail/update/members) already landed via the other session's commit `fb23faa` and its endpoints exist. Tasks 2–3 (task detail/update, custom-field-definitions, company detail, agency campaign-detail/briefs) are **left to the backend session** — do not edit `platform/`.
> - **The UI follows the *current* backend contract.** Endpoints that exist now: `GET /api/companies`, `GET /api/me`, `GET /api/:t/activity`, `GET /api/:t/projects`, `POST /api/:t/projects`, `GET /api/:t/projects/:id`, `PATCH /api/:t/projects/:id`, `GET /api/:t/projects/:pid/tasks`, `POST /api/:t/projects/:pid/tasks`, `GET /api/:t/tasks` (all/`?assignee=me`), `GET /api/:t/members`, `GET /api/rollups`, `POST /api/:t/rollups/recompute`, agency `GET/POST campaigns`, `GET approvals/pending`, `POST approvals/:id/decide`.
> - **Derive-from-list + graceful-degrade strategy** for views whose dedicated endpoint doesn't exist yet (keeps the UI working now and auto-upgrading when the backend adds them):
>   - `getCompany` → derive from `listCompanies().find(id)` (list returns id/name/type/enabled_modules/status — enough for read-only detail).
>   - `getTask` → try `GET /tasks/:id`; on 404 derive from `listTasks().find(id)` (custom_fields unavailable → `{}`).
>   - `getCampaign` → derive from `listCampaigns().find(id)`.
>   - `getFieldDefs` → `skip404 → []` (forms render standard fields only until the defs endpoint exists; custom fields light up automatically when it does).
>   - `listBriefs` → `skip404 → []` (campaign detail shows a "briefs arrive with the backend" note).
>   - Task **update** (`PATCH /tasks/:id`) and brief **create** don't exist yet → those write actions catch 404/405 and return a friendly "not available yet" message instead of crashing; the forms are built and ready.
> - The entities data layer (`lib/entities.ts`) is the single place these paths/shapes live, so when the backend session finalizes its contracts, reconciliation is a one-file change.
>
> **Executed task order for this session:** Task 4 (UI foundation) → 5 (Companies) → 6 (Projects, full CRUD, works now) → 7 (Tasks: list/detail/create now, edit graceful) → 8 (Agency: campaigns now, briefs graceful) → 9 (Rollups, works now) → 10 (docs). Backend Tasks 1–3 skipped.

## Global Constraints

- Plain CSS only — **no Tailwind/shadcn/CSS-in-JS**. Components read tokens from `src/styles`. Reuse the Plan-1 primitives (`Card`, `Eyebrow`, `Button`, `StatusBadge`, `statusColor`, `KpiTile`, `HairlineTable`, `LineChart`, `Toast` from `@/components/ui`; `Icon` from `@/components/shell/icons`).
- Design hard rules: border-radius **0** (only the sanctioned status-badge dot / chart dot may be round); **no box-shadows**; borders `0.5px` hairlines; hovers change **opacity/background-tint** only (matching the established `.lux-*`/`.erp-*` patterns); easing `var(--erp-ease)`; no emoji in copy. Empty/error states use the quiet editorial voice.
- **BFF discipline:** the UI calls only the platform. Server-only modules (`@/lib/platform`, `@/lib/session-server`, any new server-only lib) carry `import "server-only"` and must never be imported by a client component. Tokens never reach the browser. The UI never asserts identity or roles; the platform enforces RBAC/RLS. Secrets never rendered.
- Auth in the UI: `getSessionUserId()` from `@/lib/session-server`; platform calls via `platformFetch`/`platformFetch`-derived helpers from `@/lib/platform` (adds service token + `x-user-id`). `PlatformError(status, message)` is thrown on non-2xx; pages catch 403/404 to render "not authorized"/"not found" states rather than crashing.
- Platform conventions: routes in `buildServer()` (`platform/src/server.ts`) inside the `/api` register block (has `serviceAuth`+`userAuth` preHandlers); RBAC via `authorize(req, reply, resource, action)`; audit via `writeActivity(tenantId, actorId, verb, entityType, entityId, metadata?)`; DB via `withTenants([tenantId], fn)` / `withGlobal(fn)`; custom-field writes validated via `validateCustomFields(client, tenantId, entityType, values)` which returns an error string or null. Tests use `initTestDb()`/`teardownTestDb()`/`TEST_URL` + fixtures, guarded by `describe.skipIf(!TEST_URL)`.
- RBAC facts (from `platform/src/rbac/policy.ts`): any tenant **member** gets `read` on any kind within their tenant; **manager**/**company_admin** get writes; members may write `task`/`time_entry`/`comment` kinds. `agency:*` permissions gate agency writes; `approve` is the elevated action. `group_executive` (global) is the ONLY cross-company reader and ONLY via `{kind:"rollup"}`.
- Agency routes are mounted at `/api/:tenantId/modules/agency/*` and 404 when the module isn't enabled for the tenant — UI fan-outs must treat 404/403 as "skip/not available", never fatal.
- Node 22, ESM. Commit after every task. Run the covering tests + `npx next build` (UI) / `npx vitest run` (platform) before each commit.

---

### Task 1: Platform — project detail + update, members list

**Files:**
- Modify: `platform/src/server.ts` (inside the `/api` register block, after the existing project routes ~line 265)
- Test: `platform/src/business.api.test.ts` (new suite for all Plan-2 platform additions; this task adds the project + members cases)

**Interfaces:**
- Produces (consumed by Tasks 5–7 UI):
  - `GET /api/:tenantId/projects/:projectId` → `{ id, name, status, client_id, client_name, is_internal, owner_id, owner_name, start_date, due_date, custom_fields }` or 404
  - `PATCH /api/:tenantId/projects/:projectId` body `{ name?, status?, clientId?, startDate?, dueDate?, customFields? }` → `{ id }`; validates custom fields; audits `updated`
  - `GET /api/:tenantId/members` → `{ user_id, name, email, title }[]` (active memberships joined to users), for owner/assignee pickers

- [ ] **Step 1: Write the failing tests**

Add to a new file `platform/src/business.api.test.ts`:
```ts
// Plan 2 platform additions — detail/update/members/custom-fields/agency-briefs — live PG + RLS.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "./config";
import { newId, withTenants } from "./db";
import { resetModules, registerModule } from "./modules/registry";
import { agencyModule } from "./modules/agency";
import { buildServer } from "./server";
import { initTestDb, teardownTestDb, TEST_URL } from "./testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, defineCustomField } from "./testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("business API — projects/members", () => {
  let app: FastifyInstance;
  let tenant: string;
  let manager: string;
  let projectId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(agencyModule);
    tenant = await createCompany("Gaiada HQ", ["agency"]);
    manager = await createUser("mgr@gaiada.com", "Manager One", "Ops Lead");
    await addMembership(tenant, manager);
    await grantRole(manager, await createRole("manager"), "company", tenant);
    app = buildServer();
    await app.ready();

    projectId = newId();
    await withTenants([tenant], (c) =>
      c.query(`INSERT INTO projects (id, tenant_id, name, owner_id, origin_site) VALUES ($1,$2,$3,$4,'main')`,
        [projectId, tenant, "Alpha", manager]),
    );
  });
  afterAll(async () => { await app?.close(); await teardownTestDb(); });

  it("GET project detail returns owner name + fields", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/projects/${projectId}`, headers: asUser(manager) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: projectId, name: "Alpha", owner_name: "Manager One" });
  });

  it("GET project detail 404s for unknown id", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/projects/${newId()}`, headers: asUser(manager) });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH project updates status + validated custom field, audits", async () => {
    await defineCustomField(tenant, "project", "phase", "Phase", "text", [], false);
    const res = await app.inject({
      method: "PATCH", url: `/api/${tenant}/projects/${projectId}`, headers: asUser(manager),
      payload: { status: "on_hold", customFields: { phase: "discovery" } },
    });
    expect(res.statusCode).toBe(200);
    const check = await app.inject({ method: "GET", url: `/api/${tenant}/projects/${projectId}`, headers: asUser(manager) });
    expect(check.json().status).toBe("on_hold");
    expect(check.json().custom_fields.phase).toBe("discovery");
  });

  it("PATCH rejects an unknown custom field with 400", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/api/${tenant}/projects/${projectId}`, headers: asUser(manager),
      payload: { customFields: { bogus: "x" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET members lists active memberships with names", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/members`, headers: asUser(manager) });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows.some((m: { name: string }) => m.name === "Manager One")).toBe(true);
  });
});
```

Check the `defineCustomField` fixture signature in `platform/src/testing/fixtures.ts` — if its parameter order differs from `(tenantId, entityType, key, label, dataType, options, required)`, adjust the call to match the existing fixture. (Do not change the fixture.)

- [ ] **Step 2: Run to verify fail**

Run: `cd platform && npx vitest run src/business.api.test.ts`
Expected: FAIL (routes 404 / not found).

- [ ] **Step 3: Implement the routes** in `platform/src/server.ts`, after the `POST /:tenantId/projects/:projectId/tasks` route:

```ts
    // ---- ERP UI: project detail ----
    api.get<{ Params: { tenantId: string; projectId: string } }>("/:tenantId/projects/:projectId", async (req, reply) => {
      const { tenantId, projectId } = req.params;
      if (!(await authorize(req, reply, { kind: "project", tenantId, id: projectId }, "read"))) return;
      const rows = await withTenants([tenantId], (c) =>
        c.query(
          `SELECT p.id, p.name, p.status, p.client_id, cl.name AS client_name, p.is_internal,
                  p.owner_id, u.name AS owner_name, p.start_date, p.due_date, p.custom_fields
           FROM projects p
           LEFT JOIN clients cl ON cl.id = p.client_id
           LEFT JOIN users u ON u.id = p.owner_id
           WHERE p.id = $1 AND p.deleted_at IS NULL`,
          [projectId],
        ),
      );
      if (!rows.rows[0]) return reply.code(404).send({ error: "project not found" });
      return rows.rows[0];
    });

    // ---- ERP UI: project update ----
    api.patch<{ Params: { tenantId: string; projectId: string };
      Body: { name?: string; status?: string; clientId?: string | null; startDate?: string | null; dueDate?: string | null; customFields?: Record<string, unknown> } }>(
      "/:tenantId/projects/:projectId",
      async (req, reply) => {
        const { tenantId, projectId } = req.params;
        if (!(await authorize(req, reply, { kind: "project", tenantId, id: projectId }, "update"))) return;
        const b = req.body ?? {};
        try {
          await withTenants([tenantId], async (c) => {
            if (b.customFields) {
              const cfError = await validateCustomFields(c, tenantId, "project", b.customFields);
              if (cfError) throw Object.assign(new Error(cfError), { status: 400 });
            }
            const res = await c.query(
              `UPDATE projects SET
                 name = COALESCE($2, name),
                 status = COALESCE($3, status),
                 client_id = COALESCE($4, client_id),
                 start_date = COALESCE($5, start_date),
                 due_date = COALESCE($6, due_date),
                 custom_fields = COALESCE($7, custom_fields),
                 updated_at = now()
               WHERE id = $1 AND deleted_at IS NULL`,
              [projectId, b.name ?? null, b.status ?? null, b.clientId ?? null,
               b.startDate ?? null, b.dueDate ?? null, b.customFields ? JSON.stringify(b.customFields) : null],
            );
            if (res.rowCount === 0) throw Object.assign(new Error("project not found"), { status: 404 });
          });
        } catch (err) {
          const status = (err as { status?: number }).status ?? 500;
          return reply.code(status).send({ error: (err as Error).message });
        }
        await writeActivity(tenantId, req.principal.userId, "updated", "project", projectId, {});
        return { id: projectId };
      },
    );

    // ---- ERP UI: tenant members (owner/assignee pickers) ----
    api.get<{ Params: { tenantId: string } }>("/:tenantId/members", async (req, reply) => {
      const { tenantId } = req.params;
      if (!(await authorize(req, reply, { kind: "member", tenantId }, "read"))) return;
      const rows = await withTenants([tenantId], (c) =>
        c.query(
          `SELECT m.user_id, u.name, u.email, u.title
           FROM company_memberships m JOIN users u ON u.id = m.user_id
           WHERE m.deleted_at IS NULL AND u.deleted_at IS NULL AND u.status = 'active'
           ORDER BY u.name`,
        ),
      );
      return rows.rows;
    });
```

Note: `COALESCE($4, client_id)` means PATCH cannot null out an existing client_id (only change it). That is acceptable for v1 — document it with the inline comment `// COALESCE: omitted fields keep current value; nulling client is not supported in v1`.

- [ ] **Step 4: Run to verify pass**

Run: `cd platform && npx vitest run src/business.api.test.ts`
Expected: 5 project/members tests PASS. Then `npx vitest run` — full suite still green.

- [ ] **Step 5: Commit**

```bash
git add platform/src/server.ts platform/src/business.api.test.ts
git commit -m "feat(platform): project detail + PATCH update + tenant members endpoint (ERP UI plan 2, task 1)"
```

---

### Task 2: Platform — task detail + update, custom-field definitions

**Files:**
- Modify: `platform/src/server.ts` (after the routes from Task 1)
- Test: `platform/src/business.api.test.ts` (add task + custom-fields cases)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `GET /api/:tenantId/tasks/:taskId` → `{ id, title, status, priority, assignee_id, assignee_name, due_date, project_id, project_name, custom_fields }` or 404
  - `PATCH /api/:tenantId/tasks/:taskId` body `{ title?, status?, priority?, assigneeId?, dueDate?, customFields? }` → `{ id }`; validates custom fields; audits `updated`
  - `GET /api/:tenantId/custom-fields?entityType=project|task|agency_campaign|...` → `{ key, label, data_type, options, required }[]` (drives form rendering)

- [ ] **Step 1: Write the failing tests** — append to `platform/src/business.api.test.ts` a second `describe.skipIf(!TEST_URL)("business API — tasks/custom-fields", ...)` block that: seeds a tenant+manager+project+task; asserts `GET tasks/:id` returns `project_name` + `assignee_name`; `GET tasks/:id` 404s unknown; `PATCH tasks/:id` changes status + assignee and audits; `GET /custom-fields?entityType=task` returns a defined field. Mirror the Task-1 test structure and the fixture usage (`defineCustomField(tenant, "task", "severity", "Severity", "select", ["low","high"], false)`), asserting a select field round-trips.

```ts
describe.skipIf(!TEST_URL)("business API — tasks/custom-fields", () => {
  let app: FastifyInstance;
  let tenant: string, manager: string, member: string, projectId: string, taskId: string;
  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    tenant = await createCompany("Ops Co");
    manager = await createUser("m2@ops.com", "Mgr Two");
    member = await createUser("dev@ops.com", "Dev One");
    await addMembership(tenant, manager); await addMembership(tenant, member);
    await grantRole(manager, await createRole("manager"), "company", tenant);
    app = buildServer(); await app.ready();
    projectId = newId(); taskId = newId();
    await withTenants([tenant], async (c) => {
      await c.query(`INSERT INTO projects (id,tenant_id,name,owner_id,origin_site) VALUES ($1,$2,'Beta',$3,'main')`, [projectId, tenant, manager]);
      await c.query(`INSERT INTO tasks (id,tenant_id,project_id,title,origin_site) VALUES ($1,$2,$3,'Wire API','main')`, [taskId, tenant, projectId]);
    });
  });
  afterAll(async () => { await app?.close(); await teardownTestDb(); });

  it("GET task detail returns project + assignee names", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/tasks/${taskId}`, headers: asUser(manager) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: taskId, title: "Wire API", project_name: "Beta" });
  });
  it("GET task detail 404s unknown", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/tasks/${newId()}`, headers: asUser(manager) });
    expect(res.statusCode).toBe(404);
  });
  it("PATCH task updates status + assignee", async () => {
    const res = await app.inject({ method: "PATCH", url: `/api/${tenant}/tasks/${taskId}`, headers: asUser(manager),
      payload: { status: "in_progress", assigneeId: member } });
    expect(res.statusCode).toBe(200);
    const chk = await app.inject({ method: "GET", url: `/api/${tenant}/tasks/${taskId}`, headers: asUser(manager) });
    expect(chk.json()).toMatchObject({ status: "in_progress", assignee_id: member, assignee_name: "Dev One" });
  });
  it("GET custom-fields returns definitions for an entity type", async () => {
    await defineCustomField(tenant, "task", "severity", "Severity", "select", ["low", "high"], false);
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/custom-fields?entityType=task`, headers: asUser(manager) });
    expect(res.statusCode).toBe(200);
    expect(res.json().some((f: { key: string }) => f.key === "severity")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd platform && npx vitest run src/business.api.test.ts` → new block FAILs.

- [ ] **Step 3: Implement the routes** in `platform/src/server.ts`:
```ts
    // ---- ERP UI: task detail ----
    api.get<{ Params: { tenantId: string; taskId: string } }>("/:tenantId/tasks/:taskId", async (req, reply) => {
      const { tenantId, taskId } = req.params;
      if (!(await authorize(req, reply, { kind: "task", tenantId, id: taskId }, "read"))) return;
      const rows = await withTenants([tenantId], (c) =>
        c.query(
          `SELECT t.id, t.title, t.status, t.priority, t.assignee_id, u.name AS assignee_name,
                  t.due_date, t.project_id, p.name AS project_name, t.custom_fields
           FROM tasks t JOIN projects p ON p.id = t.project_id
           LEFT JOIN users u ON u.id = t.assignee_id
           WHERE t.id = $1 AND t.deleted_at IS NULL`,
          [taskId],
        ),
      );
      if (!rows.rows[0]) return reply.code(404).send({ error: "task not found" });
      return rows.rows[0];
    });

    // ---- ERP UI: task update ----
    api.patch<{ Params: { tenantId: string; taskId: string };
      Body: { title?: string; status?: string; priority?: string; assigneeId?: string | null; dueDate?: string | null; customFields?: Record<string, unknown> } }>(
      "/:tenantId/tasks/:taskId",
      async (req, reply) => {
        const { tenantId, taskId } = req.params;
        if (!(await authorize(req, reply, { kind: "task", tenantId, id: taskId }, "update"))) return;
        const b = req.body ?? {};
        try {
          await withTenants([tenantId], async (c) => {
            if (b.customFields) {
              const cfError = await validateCustomFields(c, tenantId, "task", b.customFields);
              if (cfError) throw Object.assign(new Error(cfError), { status: 400 });
            }
            const res = await c.query(
              `UPDATE tasks SET
                 title = COALESCE($2, title),
                 status = COALESCE($3, status),
                 priority = COALESCE($4, priority),
                 assignee_id = COALESCE($5, assignee_id),
                 due_date = COALESCE($6, due_date),
                 custom_fields = COALESCE($7, custom_fields),
                 updated_at = now()
               WHERE id = $1 AND deleted_at IS NULL`,
              [taskId, b.title ?? null, b.status ?? null, b.priority ?? null,
               b.assigneeId ?? null, b.dueDate ?? null, b.customFields ? JSON.stringify(b.customFields) : null],
            );
            if (res.rowCount === 0) throw Object.assign(new Error("task not found"), { status: 404 });
          });
        } catch (err) {
          const status = (err as { status?: number }).status ?? 500;
          return reply.code(status).send({ error: (err as Error).message });
        }
        await writeActivity(tenantId, req.principal.userId, "updated", "task", taskId, {});
        return { id: taskId };
      },
    );

    // ---- ERP UI: custom-field definitions (drives dynamic forms, D17) ----
    api.get<{ Params: { tenantId: string }; Querystring: { entityType?: string } }>(
      "/:tenantId/custom-fields",
      async (req, reply) => {
        const { tenantId } = req.params;
        if (!(await authorize(req, reply, { kind: "custom_field", tenantId }, "read"))) return;
        const entityType = req.query.entityType ?? "";
        const rows = await withTenants([tenantId], (c) =>
          c.query(
            `SELECT key, label, data_type, options, required FROM custom_field_definitions
             WHERE deleted_at IS NULL ${entityType ? "AND entity_type = $1" : ""} ORDER BY label`,
            entityType ? [entityType] : [],
          ),
        );
        return rows.rows;
      },
    );
```

- [ ] **Step 4: Run to verify pass** — `cd platform && npx vitest run src/business.api.test.ts` (all blocks) then `npx vitest run` (full suite).

- [ ] **Step 5: Commit**
```bash
git add platform/src/server.ts platform/src/business.api.test.ts
git commit -m "feat(platform): task detail + PATCH update + custom-field definitions endpoint (ERP UI plan 2, task 2)"
```

---

### Task 3: Platform — company detail, agency campaign detail + briefs

**Files:**
- Modify: `platform/src/server.ts` (company detail — core route)
- Modify: `platform/src/modules/agency/index.ts` (campaign detail + briefs routes)
- Test: `platform/src/business.api.test.ts` (company case); `platform/src/modules/agency/agency.test.ts` (brief cases — follow that file's existing structure)

**Interfaces:**
- Produces:
  - `GET /api/:tenantId/companies/:companyId` → `{ id, name, type, status, enabled_modules, parent_company_id, settings }` or 404 (settings returned but the UI renders only non-secret keys; treat as opaque display)
  - `GET /api/:tenantId/modules/agency/campaigns/:campaignId` → `{ id, name, status, project_id, budget_minor, currency }` or 404
  - `GET /api/:tenantId/modules/agency/campaigns/:campaignId/briefs` → `{ id, title, status, created_at }[]`
  - `POST /api/:tenantId/modules/agency/campaigns/:campaignId/briefs` body `{ title, body? }` → `{ id }` (requires `agency:campaign:create` via authorize kind `agency_brief` action `create`); audits

- [ ] **Step 1: Write failing tests** — In `business.api.test.ts` add a company-detail case (reuse a seeded tenant): `GET /api/:t/companies/:id` returns name+type, 404s unknown. In `agency.test.ts` add: seed campaign, `POST .../briefs` creates (201), `GET .../briefs` lists it, campaign detail returns the campaign. Follow `agency.test.ts`'s existing seeding helpers and the `authorize` role setup it already uses (it grants an agency role — reuse that so brief create is permitted).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement.** Company detail in `server.ts` (core), after the `/companies` list route:
```ts
    api.get<{ Params: { tenantId: string; companyId: string } }>("/:tenantId/companies/:companyId", async (req, reply) => {
      const { tenantId, companyId } = req.params;
      if (!(await authorize(req, reply, { kind: "company", tenantId, id: companyId }, "read"))) return;
      const rows = await withGlobal((c) =>
        c.query(`SELECT id, name, type, status, enabled_modules, parent_company_id, settings
                 FROM companies WHERE id = $1 AND deleted_at IS NULL`, [companyId]),
      );
      if (!rows.rows[0]) return reply.code(404).send({ error: "company not found" });
      // Guard: the requested company must be the tenant in scope (no cross-tenant peeking).
      if (companyId !== tenantId) return reply.code(404).send({ error: "company not found" });
      return rows.rows[0];
    });
```
Briefs + campaign detail in `agency/index.ts` inside `routes:`:
```ts
    scope.get<{ Params: { tenantId: string; campaignId: string } }>("/campaigns/:campaignId", async (req, reply) => {
      const { tenantId, campaignId } = req.params;
      if (!(await authorize(req, reply, { kind: "agency_campaign", tenantId, module: "agency", id: campaignId }, "read"))) return;
      const rows = await withTenants([tenantId], (c) =>
        c.query(`SELECT id, name, status, project_id, budget_minor, currency FROM agency_campaigns
                 WHERE id = $1 AND deleted_at IS NULL`, [campaignId]));
      if (!rows.rows[0]) return reply.code(404).send({ error: "campaign not found" });
      return rows.rows[0];
    });

    scope.get<{ Params: { tenantId: string; campaignId: string } }>("/campaigns/:campaignId/briefs", async (req, reply) => {
      const { tenantId, campaignId } = req.params;
      if (!(await authorize(req, reply, { kind: "agency_brief", tenantId, module: "agency" }, "read"))) return;
      const rows = await withTenants([tenantId], (c) =>
        c.query(`SELECT id, title, status, created_at FROM agency_briefs
                 WHERE campaign_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [campaignId]));
      return rows.rows;
    });

    scope.post<{ Params: { tenantId: string; campaignId: string }; Body: { title?: string; body?: string } }>(
      "/campaigns/:campaignId/briefs",
      async (req, reply) => {
        const { tenantId, campaignId } = req.params;
        const { title, body = "" } = req.body ?? {};
        if (!title) return reply.code(400).send({ error: "title required" });
        if (!(await authorize(req, reply, { kind: "agency_brief", tenantId, module: "agency" }, "create"))) return;
        const id = newId();
        await withTenants([tenantId], (c) =>
          c.query(`INSERT INTO agency_briefs (id, tenant_id, campaign_id, title, body, origin_site)
                   VALUES ($1,$2,$3,$4,$5,$6)`, [id, tenantId, campaignId, title, body, config.originSite]));
        await writeActivity(tenantId, req.principal.userId, "created", "agency_brief", id, { title });
        return reply.code(201).send({ id });
      },
    );
```
Add `agency_brief` to the module `permissions` list if the policy requires a registered permission for the kind; otherwise the kind is authorized by role (member read, agency role create) via the generic policy — verify against `policy.ts` (agency writes need the agency role/manager). If brief-create is denied for the agency role the test uses, align the authorize `kind`/`action` with how `agency_campaign` create is already authorized in the same file.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/business.api.test.ts src/modules/agency/agency.test.ts`, then full `npx vitest run`.

- [ ] **Step 5: Commit**
```bash
git add platform/src/server.ts platform/src/modules/agency
git commit -m "feat(platform): company detail + agency campaign detail & briefs (ERP UI plan 2, task 3)"
```

---

### Task 4: UI — entities data layer + shared page/detail/form primitives

**Files:**
- Create: `platform-ui/src/lib/entities.ts` (server-only data functions)
- Create: `platform-ui/src/components/PageHeader.tsx`
- Create: `platform-ui/src/components/DescriptionList.tsx` + `detail.css`
- Create: `platform-ui/src/components/forms/CustomFields.tsx` (renders field defs → inputs), `Field.tsx` (labelled input/select/textarea), `forms.css`
- Create: `platform-ui/src/lib/form.ts` (parse a FormData + field-def list into a typed `customFields` object)
- Test: `platform-ui/src/lib/form.test.ts`, `platform-ui/src/components/forms/CustomFields.test.tsx`

**Interfaces:**
- Produces (consumed by Tasks 5–9):
  - `entities.ts` (all `import "server-only"`): `listCompanies(userId)`, `getCompany(userId,tenantId,companyId)`, `listProjects(userId,tenantId)`, `getProject(userId,tenantId,projectId)`, `listProjectTasks(userId,tenantId,projectId)`, `listTasks(userId,tenantId)` (all tenant tasks), `getTask(userId,tenantId,taskId)`, `listMembers(userId,tenantId)`, `getFieldDefs(userId,tenantId,entityType)`, `listCampaigns(userId,tenantId)`, `getCampaign(userId,tenantId,campaignId)`, `listBriefs(userId,tenantId,campaignId)`, `getRollups(userId,period?)`. Each wraps `platformFetch`; list functions that fan out over the agency module catch `PlatformError` 404/403 → `[]`. Export the row types (`Project`, `ProjectDetail`, `Task`, `TaskDetail`, `Member`, `FieldDef`, `Company`, `CompanyDetail`, `Campaign`, `Brief`, `RollupRow`).
  - `type FieldDef = { key: string; label: string; data_type: "text"|"number"|"boolean"|"date"|"select"; options: string[]; required: boolean }`
  - `PageHeader({ eyebrow, title, subtitle?, actions? })` — the standard page title block used by every page.
  - `DescriptionList({ items: { label: string; value: ReactNode }[] })` — hairline key/value rows for detail views.
  - `Field({ name, label, type?, defaultValue?, options?, required? })` — one labelled control (text/number/date/select/textarea/checkbox) in the design-system style.
  - `CustomFields({ defs, values? })` — renders a `Field` per def, name-prefixed `cf_<key>`, hydrating `values`.
  - `form.ts`: `parseCustomFields(formData: FormData, defs: FieldDef[]): Record<string, unknown>` — reads `cf_<key>` entries, coerces by `data_type` (number→Number, boolean→checkbox present, others→string), omits empty optional fields; `export function coerceField(def, raw): unknown`.

- [ ] **Step 1: Write failing tests**

`platform-ui/src/lib/form.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseCustomFields, coerceField } from "./form";
import type { FieldDef } from "./entities";

const defs: FieldDef[] = [
  { key: "phase", label: "Phase", data_type: "text", options: [], required: false },
  { key: "count", label: "Count", data_type: "number", options: [], required: false },
  { key: "active", label: "Active", data_type: "boolean", options: [], required: false },
  { key: "tier", label: "Tier", data_type: "select", options: ["a", "b"], required: false },
];

describe("coerceField", () => {
  it("coerces number and boolean", () => {
    expect(coerceField(defs[1], "3")).toBe(3);
    expect(coerceField(defs[2], "on")).toBe(true);
    expect(coerceField(defs[2], null)).toBe(false);
  });
});

describe("parseCustomFields", () => {
  it("reads cf_-prefixed values, coerces, omits empty optional", () => {
    const fd = new FormData();
    fd.set("cf_phase", "discovery");
    fd.set("cf_count", "5");
    fd.set("cf_active", "on");
    fd.set("cf_tier", "");
    const out = parseCustomFields(fd, defs);
    expect(out).toEqual({ phase: "discovery", count: 5, active: true });
  });
});
```

`platform-ui/src/components/forms/CustomFields.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { CustomFields } from "./CustomFields";
import type { FieldDef } from "@/lib/entities";

const defs: FieldDef[] = [
  { key: "phase", label: "Phase", data_type: "text", options: [], required: true },
  { key: "tier", label: "Tier", data_type: "select", options: ["a", "b"], required: false },
];

describe("CustomFields", () => {
  it("renders a control per definition with cf_ names and hydrates values", () => {
    render(<CustomFields defs={defs} values={{ phase: "discovery" }} />);
    const phase = screen.getByLabelText(/Phase/) as HTMLInputElement;
    expect(phase.name).toBe("cf_phase");
    expect(phase.value).toBe("discovery");
    expect(screen.getByLabelText(/Tier/)).toBeInTheDocument();
  });
  it("renders nothing when there are no defs", () => {
    const { container } = render(<CustomFields defs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd platform-ui && npm test` → new tests fail.

- [ ] **Step 3: Implement `lib/entities.ts`** (server-only). Each function calls `platformFetch<T>(path, userId)`. Example shape (implement all listed functions + exported types the same way):
```ts
import "server-only";
import { platformFetch, PlatformError } from "./platform";

export interface Project { id: string; name: string; status: string; client_id: string | null; is_internal: boolean; owner_id: string | null; due_date: string | null; custom_fields: Record<string, unknown> }
export interface ProjectDetail extends Project { client_name: string | null; owner_name: string | null; start_date: string | null }
export interface Task { id: string; title: string; status: string | null; priority: string | null; assignee_id: string | null; due_date: string | null; project_id: string; project_name: string }
export interface TaskDetail extends Task { assignee_name: string | null; custom_fields: Record<string, unknown> }
export interface Member { user_id: string; name: string; email: string; title: string | null }
export interface FieldDef { key: string; label: string; data_type: "text" | "number" | "boolean" | "date" | "select"; options: string[]; required: boolean }
export interface Company { id: string; name: string; type: string | null; enabled_modules: string[]; status: string }
export interface CompanyDetail extends Company { parent_company_id: string | null; settings: Record<string, unknown> }
export interface Campaign { id: string; name: string; status: string; project_id: string | null; budget_minor: number | null; currency: string | null }
export interface Brief { id: string; title: string; status: string; created_at: string }
export interface RollupRow { tenant_id: string; company: string; module: string; metric_key: string; numerator: number; denominator: number | null; currency: string | null; period: string }

const skip404 = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
  try { return await p; } catch (e) { if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback; throw e; }
};

export const listCompanies = (u: string) => platformFetch<Company[]>(`/api/companies`, u);
export const getCompany = (u: string, t: string, id: string) => platformFetch<CompanyDetail>(`/api/${t}/companies/${id}`, u);
export const listProjects = (u: string, t: string) => platformFetch<Project[]>(`/api/${t}/projects`, u);
export const getProject = (u: string, t: string, id: string) => platformFetch<ProjectDetail>(`/api/${t}/projects/${id}`, u);
export const listTasks = (u: string, t: string) => platformFetch<Task[]>(`/api/${t}/tasks`, u);
export const listProjectTasks = (u: string, t: string, pid: string) => platformFetch<Task[]>(`/api/${t}/projects/${pid}/tasks`, u);
export const getTask = (u: string, t: string, id: string) => platformFetch<TaskDetail>(`/api/${t}/tasks/${id}`, u);
export const listMembers = (u: string, t: string) => platformFetch<Member[]>(`/api/${t}/members`, u);
export const getFieldDefs = (u: string, t: string, entityType: string) => platformFetch<FieldDef[]>(`/api/${t}/custom-fields?entityType=${entityType}`, u);
export const listCampaigns = (u: string, t: string) => skip404(platformFetch<Campaign[]>(`/api/${t}/modules/agency/campaigns`, u), []);
export const getCampaign = (u: string, t: string, id: string) => platformFetch<Campaign>(`/api/${t}/modules/agency/campaigns/${id}`, u);
export const listBriefs = (u: string, t: string, cid: string) => skip404(platformFetch<Brief[]>(`/api/${t}/modules/agency/campaigns/${cid}/briefs`, u), []);
export const getRollups = (u: string, period?: string) => platformFetch<RollupRow[]>(`/api/rollups${period ? `?period=${period}` : ""}`, u);
```

- [ ] **Step 4: Implement `form.ts`, `PageHeader.tsx`, `DescriptionList.tsx` + `detail.css`, `forms/Field.tsx`, `forms/CustomFields.tsx` + `forms.css`.**

`lib/form.ts`:
```ts
import type { FieldDef } from "./entities";

export function coerceField(def: FieldDef, raw: FormDataEntryValue | null): unknown {
  if (def.data_type === "boolean") return raw != null && raw !== "" && raw !== "false";
  const s = typeof raw === "string" ? raw : "";
  if (def.data_type === "number") return s === "" ? undefined : Number(s);
  return s === "" ? undefined : s;
}

export function parseCustomFields(formData: FormData, defs: FieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const v = coerceField(def, formData.get(`cf_${def.key}`));
    if (v === undefined) { if (def.data_type === "boolean") out[def.key] = false; continue; }
    out[def.key] = v;
  }
  return out;
}
```
`Field.tsx` renders a `<label>` (Eyebrow style) wrapping the right control by `type` (`text|number|date` → input, `select` → select with options, `textarea` → textarea, `boolean` → checkbox), applying the hairline-underline input style used on the login page. `CustomFields.tsx` maps `defs` → `<Field name={`cf_${d.key}`} label={d.label + (d.required?" *":"")} type={d.data_type==="select"?"select":d.data_type==="boolean"?"boolean":d.data_type==="number"?"number":d.data_type==="date"?"date":"text"} options={d.options} defaultValue={values?.[d.key]}/>`; returns `null` when `defs.length===0`. `PageHeader.tsx` renders the eyebrow+H1+subtitle+actions block (extract the exact styles used inline on the dashboard/approvals pages). `DescriptionList.tsx` renders hairline key/value rows.

- [ ] **Step 5: Run to verify pass** — `cd platform-ui && npm test` (form + CustomFields tests pass; all prior green). `npx next build` succeeds.

- [ ] **Step 6: Commit**
```bash
git add platform-ui/src/lib/entities.ts platform-ui/src/lib/form.ts platform-ui/src/lib/form.test.ts platform-ui/src/components/PageHeader.tsx platform-ui/src/components/DescriptionList.tsx platform-ui/src/components/detail.css platform-ui/src/components/forms
git commit -m "feat(platform-ui): entities data layer + PageHeader/DescriptionList + dynamic custom-field forms (ERP UI plan 2, task 4)"
```

---

### Task 5: UI — Companies (list + detail, read-only)

**Files:**
- Create: `platform-ui/src/app/(app)/companies/page.tsx`, `platform-ui/src/app/(app)/companies/[companyId]/page.tsx`
- Test: none new (composition of tested pieces); verified via build + live check

**Interfaces:**
- Consumes: `listCompanies`, `getCompany`, `PageHeader`, `DescriptionList`, `Card`, `HairlineTable`, `StatusBadge`.
- Produces: `/companies` (table: name, type, modules, status → rows link to detail) and `/companies/[companyId]` (DescriptionList of company facts + enabled-modules list). Companies are read-only in Plan 2 (editing lives in the Admin section, Plan 4).

- [ ] **Step 1: Implement the list page** — server component: `userId=getSessionUserId()` (redirect if none), `companies=await listCompanies(userId)`, render `PageHeader` (eyebrow "Business", title "Companies") + a `Card` containing a `HairlineTable` whose first cell is a `<Link href={`/companies/${c.id}`}>`. Empty state when none.
- [ ] **Step 2: Implement the detail page** — `getCompany(userId, companyId, companyId)` wrapped to catch `PlatformError` 404 → Next `notFound()`; render `PageHeader` (title = company name) + `DescriptionList` (Type, Status, Parent, Enabled modules joined). No secret settings values rendered (render only the keys of `settings`, or omit settings entirely — omit for v1).
- [ ] **Step 3: Verify** — `npx next build` succeeds; nav "Companies" reaches the list; a row opens detail (live check with seed data).
- [ ] **Step 4: Commit**
```bash
git add platform-ui/src/app/(app)/companies
git commit -m "feat(platform-ui): Companies list + detail (read-only) (ERP UI plan 2, task 5)"
```

---

### Task 6: UI — Projects (list, detail, create/edit with custom fields)

**Files:**
- Create: `platform-ui/src/app/(app)/projects/page.tsx`, `.../projects/[projectId]/page.tsx`, `.../projects/new/page.tsx`, `.../projects/[projectId]/edit/page.tsx`, `platform-ui/src/app/(app)/projects/actions.ts`
- Create: `platform-ui/src/components/forms/ProjectForm.tsx` (client component)
- Test: none new beyond CustomFields/form (Task 4); verified via build + live check

**Interfaces:**
- Consumes: `listProjects`, `getProject`, `listProjectTasks`, `getFieldDefs`, `listMembers`, `CustomFields`, `parseCustomFields`, primitives.
- Produces:
  - `/projects` — table (name→detail link, status badge, due date, owner). "New project" action in the header.
  - `/projects/[projectId]` — `DescriptionList` (status, client, owner, dates, custom-field values) + a tasks `HairlineTable` (from `listProjectTasks`) + Edit action.
  - `/projects/new` + `/projects/[projectId]/edit` — `ProjectForm` (name, status, owner select from members, dates, `CustomFields` from `getFieldDefs("project")`).
  - `actions.ts`: `createProject(formData)` and `updateProject(projectId, formData)` server actions — read session, fetch field defs, `parseCustomFields`, POST/PATCH the platform, `revalidatePath`, `redirect` to the detail page; return `{ok,error}` on failure for the form to show.

- [ ] **Step 1: Implement `actions.ts`** — both actions: resolve `userId` via `getSessionUserId` (error if none) and the active tenant via `getActiveTenant(await getMe(userId))`; `defs = await getFieldDefs(userId, tenant, "project")`; `customFields = parseCustomFields(formData, defs)`; call `platformFetch` POST `/api/${t}/projects` (create) or PATCH `/api/${t}/projects/${id}` (update) with `{ name, status, clientId, startDate, dueDate, customFields }` read from formData; on success `revalidatePath("/projects")` + `redirect` to detail; on `PlatformError` return `{ ok:false, error }`.
- [ ] **Step 2: Implement `ProjectForm.tsx`** ("use client") — uses `useActionState`; renders `Field`s (name required, status select with the known statuses `active|on_hold|completed|archived`, owner select from a `members` prop, start/due date inputs) + `<CustomFields defs={defs} values={project?.custom_fields} />` + submit `Button`; shows `state.error`. Takes props `{ action, defs, members, project? }`.
- [ ] **Step 3: Implement the four pages** — list, detail, new (renders `<ProjectForm action={createProject} defs={await getFieldDefs(...)} members={await listMembers(...)} />`), edit (same with `project` + `updateProject` bound to the id via `.bind(null, projectId)`). Detail catches 404 → `notFound()`.
- [ ] **Step 4: Verify** — `npm test` (unchanged green), `npx next build`; live: create a project with a custom field, see it in detail, edit it.
- [ ] **Step 5: Commit**
```bash
git add platform-ui/src/app/(app)/projects platform-ui/src/components/forms/ProjectForm.tsx
git commit -m "feat(platform-ui): Projects list/detail + create/edit with D17 custom fields (ERP UI plan 2, task 6)"
```

---

### Task 7: UI — Tasks (list, detail, create/edit, inline status/assignee)

**Files:**
- Create: `platform-ui/src/app/(app)/tasks/page.tsx`, `.../tasks/[taskId]/page.tsx`, `.../tasks/[taskId]/edit/page.tsx`, `platform-ui/src/app/(app)/tasks/actions.ts`
- Create: `platform-ui/src/components/forms/TaskForm.tsx` (client)
- Test: none new; verified via build + live check

**Interfaces:**
- Consumes: `listTasks`, `getTask`, `listMembers`, `getFieldDefs("task")`, `CustomFields`, `parseCustomFields`, primitives.
- Produces:
  - `/tasks` — all tenant tasks table (title→detail, project, assignee, due, status badge).
  - `/tasks/[taskId]` — `DescriptionList` (project link, status, priority, assignee, due, custom fields) + Edit action.
  - `/tasks/[taskId]/edit` — `TaskForm` (title, status select `todo|in_progress|blocked|done`, priority select `low|normal|high|urgent`, assignee select from members, due date, `CustomFields`).
  - Task creation is per-project in v1 (a "New task" action on the project detail page posting to the existing `POST /api/:t/projects/:pid/tasks`) — so this task adds a `createTaskInProject(projectId, formData)` action and a minimal inline "add task" form on the project detail page, OR a `/tasks/new?projectId=` page. Choose the `/tasks/new?projectId=` page for consistency with projects.
  - `actions.ts`: `updateTask(taskId, formData)` and `createTaskInProject(projectId, formData)` — same pattern as projects (session → tenant → defs → parseCustomFields → PATCH/POST → revalidate + redirect).

- [ ] **Step 1: Implement `actions.ts`** (updateTask, createTaskInProject) mirroring the projects actions, using entity type `"task"` for field defs, PATCH `/api/${t}/tasks/${id}` and POST `/api/${t}/projects/${pid}/tasks`.
- [ ] **Step 2: Implement `TaskForm.tsx`** ("use client", `useActionState`) with the fields above + `CustomFields`.
- [ ] **Step 3: Implement the pages** (list, detail, edit, new). `new` reads `projectId` from `searchParams`; if absent, show a project picker (`listProjects`) first. Detail catches 404 → `notFound()`.
- [ ] **Step 4: Verify** — `npm test`, `npx next build`; live: create a task under a project, edit its status/assignee, confirm the change persists and audits.
- [ ] **Step 5: Commit**
```bash
git add platform-ui/src/app/(app)/tasks platform-ui/src/components/forms/TaskForm.tsx
git commit -m "feat(platform-ui): Tasks list/detail + create/edit with custom fields (ERP UI plan 2, task 7)"
```

---

### Task 8: UI — Agency (campaigns list + detail with briefs)

**Files:**
- Create: `platform-ui/src/app/(app)/agency/page.tsx`, `.../agency/[campaignId]/page.tsx`, `platform-ui/src/app/(app)/agency/actions.ts`
- Create: `platform-ui/src/components/forms/BriefForm.tsx` (client) and a small `CampaignForm.tsx` (client) OR inline create
- Test: none new; verified via build + live check

**Interfaces:**
- Consumes: `listCampaigns`, `getCampaign`, `listBriefs`, primitives; existing approvals live on `/approvals`.
- Produces:
  - `/agency` — campaigns table (name→detail, status, budget) + "New campaign" (posts `POST /api/:t/modules/agency/campaigns` with name + a project picker from `listProjects`); a link/callout to `/approvals` for pending approvals; if the agency module is disabled for the active tenant (`listCampaigns` returned `[]` due to 404) show the quiet "Agency isn't enabled for this company" empty state.
  - `/agency/[campaignId]` — campaign `DescriptionList` + a briefs `HairlineTable` (from `listBriefs`) + a "New brief" form (title, body) posting `createBrief`.
  - `actions.ts`: `createCampaign(formData)` and `createBrief(campaignId, formData)` — session → tenant → POST → revalidate + redirect.

- [ ] **Step 1: Implement `actions.ts`** (createCampaign, createBrief).
- [ ] **Step 2: Implement forms** (CampaignForm with name + project select; BriefForm with title + body textarea).
- [ ] **Step 3: Implement the two pages** with the module-disabled empty state and the approvals callout.
- [ ] **Step 4: Verify** — `npm test`, `npx next build`; live: create a campaign, open it, add a brief.
- [ ] **Step 5: Commit**
```bash
git add platform-ui/src/app/(app)/agency platform-ui/src/components/forms/BriefForm.tsx platform-ui/src/components/forms/CampaignForm.tsx
git commit -m "feat(platform-ui): Agency campaigns list/detail + briefs (ERP UI plan 2, task 8)"
```

---

### Task 9: UI — Rollups (executive cross-company view)

**Files:**
- Create: `platform-ui/src/app/(app)/rollups/page.tsx`, `platform-ui/src/app/(app)/rollups/actions.ts`
- Test: `platform-ui/src/lib/rollups.test.ts` (grouping helper)

**Interfaces:**
- Consumes: `getRollups`, primitives.
- Produces:
  - `/rollups` — group_executive/platform_admin only. The nav already gates the link; the page ALSO handles `PlatformError` 403 by rendering a "This view is limited to group executives" state (never a crash). Groups `RollupRow[]` by company then metric into `KpiTile`s / a table; shows the period; a "Recompute" action per company (calls `POST /api/:t/rollups/recompute`).
  - `lib/rollups.ts` (pure, unit-tested): `groupRollups(rows: RollupRow[]): { company: string; tenantId: string; metrics: { key: string; value: number; ratio: number | null; currency: string | null }[] }[]` — value = numerator, ratio = denominator ? numerator/denominator : null.
  - `actions.ts`: `recompute(tenantId)` — POST recompute, revalidate `/rollups`.

- [ ] **Step 1: Write the failing test** for `groupRollups` (two companies, one with a denominator ratio) asserting grouping + ratio math.
- [ ] **Step 2: Implement `lib/rollups.ts`** and run the test green.
- [ ] **Step 3: Implement `actions.ts` + the page** with the 403 empty state and per-company recompute button + `Toast` on success.
- [ ] **Step 4: Verify** — `npm test`, `npx next build`; live: as a group_executive, view rollups; as a plain member, hitting `/rollups` shows the limited-access state (not a 500).
- [ ] **Step 5: Commit**
```bash
git add platform-ui/src/app/(app)/rollups platform-ui/src/lib/rollups.ts platform-ui/src/lib/rollups.test.ts
git commit -m "feat(platform-ui): Rollups executive cross-company view + recompute (ERP UI plan 2, task 9)"
```

---

### Task 10: Docs sync

**Files:**
- Modify: `docs/superpowers/plans/2026-07-05-CHECKLIST.md` (Phase 5 — add Plan 2 items done), `CLAUDE.md` (platform-ui bullet: business modules live), `README.md` (only if the platform-ui row needs its status line updated)

**Interfaces:** Produces accurate status docs.

- [ ] **Step 1: Update the CHECKLIST** — under Phase 5, add a "Plan 2 — Business modules" subsection marking tasks 1–10 done (☑), matching the existing ☐/▣/☑ convention.
- [ ] **Step 2: Update CLAUDE.md** — extend the `platform-ui/` status bullet to note Companies/Projects/Tasks/Agency/Rollups pages with D17 custom-field forms are built; note follow-up plans 3–5.
- [ ] **Step 3: Commit**
```bash
git add docs/superpowers/plans/2026-07-05-CHECKLIST.md CLAUDE.md README.md
git commit -m "docs: ERP UI plan 2 (business modules) complete (ERP UI plan 2, task 10)"
```

---

## Follow-up plans (not in this document)

- **Plan 3 — Admin APIs + Systems pages:** uniform `GET/PUT /admin/*` in bot → gateway → agents → hub → knowledge; platform proxy `/api/admin/:system/*`; Systems settings pages.
- **Plan 4 — Admin section + step-up:** users/roles, identity-links, module-enable, compliance gates, audit browser; `/step-up` landing (D4); session revocation (D11).
- **Plan 5 — Polish:** layout presets, density toggle, global search wiring, a11y audit, Playwright e2e, and the deferred Plan-1 minors (fail-loud service token, exact prototype icon paths, `getActiveTenant` out of the "use server" module).
