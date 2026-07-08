# Gaiada ERP UI — Plan 1: Foundation (shell + My Work + Approvals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `platform-ui/` Next.js project with the ported Luxury Minimalist design system (GAIADA / ERP Suite branding), authenticated shell, and two real-data pages: My Work (dashboard) and Approvals (unified inbox v1 = agency approvals), backed by three small platform API additions.

**Architecture:** `platform-ui/` is a standalone Next.js App Router project acting as a BFF: server components/actions call the platform API with `Authorization: Bearer $PLATFORM_SERVICE_TOKEN` + `x-user-id` from an HMAC-signed session cookie; the browser never sees tokens. All styling is plain CSS from the ported 3-tier tokens (zero radius, no shadows, 0.5px hairlines, opacity hovers). The platform gains `/api/me`, `/api/:tenantId/activity`, `/api/:tenantId/tasks` and a `users.title` column so the UI can render principal, nav gating, and dashboard data.

**Tech Stack:** Next.js 15 (App Router, TS, no Tailwind), React 19, plain CSS design tokens, vitest + @testing-library/react (jsdom), platform = existing Fastify/PG project (vitest on live PG).

**Spec:** `docs/superpowers/specs/2026-07-05-gaiada-erp-ui-design.md` (approved). This plan covers spec §9 stages 1–2. Stages 3–6 (business modules, admin APIs + Systems pages, Admin section, polish) are follow-up plans.

## Global Constraints

- Brand: wordmark **GAIADA**, product tag **ERP Suite** (user-confirmed). Accent default `#6E5A43`.
- Plain CSS only — **no Tailwind, no shadcn, no CSS-in-JS lib**. Components read tokens from `src/styles/tokens/*.css`.
- Design-system hard rules: border-radius **0** everywhere; **no box-shadows**; borders only `0.5px solid rgba(26,25,22,.18)`-style hairlines; hovers change **opacity only**; spacing values from {10,15,20,30,40,50,60,100} px (component-internal values from the prototype like 22px paddings are allowed where the prototype uses them); easing `cubic-bezier(.22,.61,.36,1)` 180–520ms; no emoji in UI copy.
- `platform-ui/` is a **separate standalone project** (own package.json, tests, Dockerfile). It calls **only the platform API** (`PLATFORM_URL`). No provider keys, no service URLs of other systems.
- UI never asserts roles; it forwards the session's userId; the platform mints the principal (D4) and enforces RBAC/RLS. Secrets are never rendered.
- Sidebar user card shows the real logged-in user (for Hansel: **Clement Hansel — AI Manager — CH**). No hardcoded persona.
- Platform code follows its existing conventions: routes in `buildServer()`, `authorize()` + `writeActivity()`, tests via `initTestDb()`/fixtures with `describe.skipIf(!TEST_URL)`.
- Node 22, ESM. platform-ui dev port **3005** (platform is 3004).
- Commit after every task (git root is the outer repo; paths in commits are relative to `gaiada/Projects/gaiada-system/`).

---

### Task 1: Platform API additions (`/api/me`, activity feed, cross-project tasks, `users.title`)

**Files:**
- Create: `platform/migrations/0003_user_title.sql`
- Modify: `platform/src/server.ts` (inside the `/api` register block, after the `/companies` route)
- Modify: `platform/src/testing/fixtures.ts` (createUser gains optional title)
- Test: `platform/src/me.api.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 5–8):
  - `GET /api/me` → `{ userId: string; name: string; email: string; title: string | null; assurance: string; companies: {id: string; name: string; type: string|null}[]; roles: {role: string; scopeType: string; scopeId: string|null}[] }`
  - `GET /api/:tenantId/activity?limit=20` → `{ id, actor_id, actor_name, verb, target_entity_type, target_entity_id, metadata, occurred_at }[]`
  - `GET /api/:tenantId/tasks?assignee=me` → `{ id, title, status, priority, assignee_id, due_date, project_id, project_name }[]` (assignee=me filters to the acting principal)
- Auth for all three: service token + `x-user-id` (existing `serviceAuth`+`userAuth` hooks).

- [ ] **Step 1: Write the migration**

`platform/migrations/0003_user_title.sql`:
```sql
-- Job title shown on the ERP UI user card (e.g. 'AI Manager'). Display-only; not authz.
ALTER TABLE users ADD COLUMN IF NOT EXISTS title text;
```

- [ ] **Step 2: Extend the fixture**

In `platform/src/testing/fixtures.ts`, replace `createUser` with:
```ts
export async function createUser(email: string, name = email.split("@")[0], title: string | null = null): Promise<string> {
  const id = newId();
  await withGlobal((c) =>
    c.query(`INSERT INTO users (id, email, name, title, origin_site) VALUES ($1, $2, $3, $4, $5)`, [
      id, email, name, title, site(),
    ]),
  );
  return id;
}
```

- [ ] **Step 3: Write the failing tests**

`platform/src/me.api.test.ts`:
```ts
// Task 1 (ERP UI plan 1): /api/me, tenant activity feed, cross-project task list.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "./config";
import { withTenants } from "./db";
import { newId } from "./db";
import { resetModules } from "./modules/registry";
import { buildServer } from "./server";
import { initTestDb, teardownTestDb, TEST_URL } from "./testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "./testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("me / activity / tasks API", () => {
  let app: FastifyInstance;
  let tenant: string;
  let hansel: string;
  let projectId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    tenant = await createCompany("Gaiada HQ");
    hansel = await createUser("hansel@gaiada.com", "Clement Hansel", "AI Manager");
    await addMembership(tenant, hansel);
    const managerRole = await createRole("manager");
    await grantRole(hansel, managerRole, "company", tenant);
    app = buildServer();
    await app.ready();

    // seed one project + one task assigned to hansel (direct SQL via RLS-bound client)
    projectId = newId();
    const taskId = newId();
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO projects (id, tenant_id, name, owner_id, origin_site) VALUES ($1,$2,$3,$4,$5)`,
        [projectId, tenant, "ERP UI build", hansel, "main"],
      );
      await c.query(
        `INSERT INTO tasks (id, tenant_id, project_id, title, assignee_id, due_date, origin_site)
         VALUES ($1,$2,$3,$4,$5, now()::date, $6)`,
        [taskId, tenant, projectId, "Port design system", hansel, "main"],
      );
    });
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("GET /api/me returns principal + profile + companies", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me", headers: asUser(hansel) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("Clement Hansel");
    expect(body.title).toBe("AI Manager");
    expect(body.companies.map((c: { name: string }) => c.name)).toContain("Gaiada HQ");
    expect(body.roles.some((r: { role: string }) => r.role === "manager")).toBe(true);
  });

  it("GET /api/:tenantId/tasks?assignee=me returns my tasks with project name", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/tasks?assignee=me`, headers: asUser(hansel) });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Port design system");
    expect(rows[0].project_name).toBe("ERP UI build");
  });

  it("GET /api/:tenantId/activity returns recent audit rows with actor name", async () => {
    // creating a project via the API writes an activity row
    const create = await app.inject({
      method: "POST", url: `/api/${tenant}/projects`, headers: asUser(hansel),
      payload: { name: "Second project" },
    });
    expect(create.statusCode).toBe(201);
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/activity?limit=5`, headers: asUser(hansel) });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].verb).toBe("created");
    expect(rows[0].actor_name).toBe("Clement Hansel");
  });

  it("outsider without membership gets 403 on tasks/activity", async () => {
    const outsider = await createUser("outsider@x.test");
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/tasks?assignee=me`, headers: asUser(outsider) });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd platform && npx vitest run src/me.api.test.ts`
Expected: FAIL — 404s (`/api/me` not found) / column `title` missing.

- [ ] **Step 5: Implement the routes**

In `platform/src/server.ts`, inside the `/api` register block, directly after the `/companies` route, add:

```ts
    // ---- ERP UI: who am I (principal + profile) ----
    api.get("/me", async (req, reply) => {
      if (!req.principal.userId) return reply.code(401).send({ error: "no user" });
      const profile = await withGlobal((c) =>
        c.query<{ name: string; email: string; title: string | null }>(
          `SELECT name, email, title FROM users WHERE id = $1 AND deleted_at IS NULL`,
          [req.principal.userId],
        ),
      );
      const companies = req.principal.companies.length
        ? await withGlobal((c) =>
            c.query(`SELECT id, name, type FROM companies WHERE deleted_at IS NULL AND id = ANY($1::uuid[])`, [
              req.principal.companies,
            ]),
          )
        : { rows: [] };
      return {
        userId: req.principal.userId,
        assurance: req.principal.assurance,
        name: profile.rows[0]?.name ?? "",
        email: profile.rows[0]?.email ?? "",
        title: profile.rows[0]?.title ?? null,
        companies: companies.rows,
        roles: req.principal.roles,
      };
    });

    // ---- ERP UI: tenant activity feed (read of the existing audit trail) ----
    api.get<{ Params: { tenantId: string }; Querystring: { limit?: string } }>(
      "/:tenantId/activity",
      async (req, reply) => {
        const { tenantId } = req.params;
        if (!(await authorize(req, reply, { kind: "activity", tenantId }, "read"))) return;
        const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
        const rows = await withTenants([tenantId], (c) =>
          c.query(
            `SELECT a.id, a.actor_id, u.name AS actor_name, a.verb, a.target_entity_type,
                    a.target_entity_id, a.metadata, a.occurred_at
             FROM activities a LEFT JOIN users u ON u.id = a.actor_id
             ORDER BY a.occurred_at DESC LIMIT $1`,
            [limit],
          ),
        );
        return rows.rows;
      },
    );

    // ---- ERP UI: tasks across projects (dashboard "assigned to you") ----
    api.get<{ Params: { tenantId: string }; Querystring: { assignee?: string } }>(
      "/:tenantId/tasks",
      async (req, reply) => {
        const { tenantId } = req.params;
        if (!(await authorize(req, reply, { kind: "task", tenantId }, "read"))) return;
        const mine = req.query.assignee === "me";
        const rows = await withTenants([tenantId], (c) =>
          c.query(
            `SELECT t.id, t.title, t.status, t.priority, t.assignee_id, t.due_date,
                    t.project_id, p.name AS project_name
             FROM tasks t JOIN projects p ON p.id = t.project_id
             WHERE t.deleted_at IS NULL ${mine ? "AND t.assignee_id = $1" : ""}
             ORDER BY t.due_date NULLS LAST, t.created_at DESC LIMIT 100`,
            mine ? [req.principal.userId] : [],
          ),
        );
        return rows.rows;
      },
    );
```

Check `platform/src/rbac/policy.ts`: if resource kinds are validated against a known list, add `"activity"` wherever `"task"`-style kinds are declared with the same read semantics (member-readable within tenant). If `check()` is generic over kinds, no change is needed.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd platform && npx vitest run src/me.api.test.ts`
Expected: 4 tests PASS. Then full platform suite: `npx vitest run` — all existing tests still pass (createUser signature change is backward-compatible).

- [ ] **Step 7: Commit**

```bash
git add platform/migrations/0003_user_title.sql platform/src/server.ts platform/src/testing/fixtures.ts platform/src/me.api.test.ts
git commit -m "feat(platform): /api/me + activity feed + cross-project tasks + users.title (ERP UI plan 1, task 1)"
```

---

### Task 2: Scaffold `platform-ui/` (Next.js, vitest, project hygiene)

**Files:**
- Create: `platform-ui/package.json`, `platform-ui/tsconfig.json`, `platform-ui/next.config.ts`, `platform-ui/vitest.config.ts`, `platform-ui/vitest.setup.ts`, `platform-ui/.gitignore`, `platform-ui/.env.example`, `platform-ui/README.md`, `platform-ui/src/app/layout.tsx`, `platform-ui/src/app/page.tsx`

**Interfaces:**
- Produces: runnable Next.js app on port 3005; `npm test` runs vitest with jsdom + testing-library.

- [ ] **Step 1: Scaffold manually (no create-next-app — we want exact control)**

`platform-ui/package.json`:
```json
{
  "name": "gaiada-platform-ui",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev -p 3005",
    "build": "next build",
    "start": "next start -p 3005",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "next": "^15.3.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.0",
    "@testing-library/react": "^16.0.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`platform-ui/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`platform-ui/next.config.ts`:
```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = {};
export default nextConfig;
```

`platform-ui/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
```

`platform-ui/vitest.setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

`platform-ui/.gitignore`:
```
node_modules
.next
.env
*.tsbuildinfo
next-env.d.ts
```

`platform-ui/.env.example`:
```
# Platform API (the ONLY backend this UI talks to)
PLATFORM_URL=http://localhost:3004
PLATFORM_SERVICE_TOKEN=dev-svc-token
# HMAC key for the session cookie (any long random string in dev)
SESSION_SECRET=change-me-long-random
```

`platform-ui/src/app/layout.tsx` (minimal for now; Task 3 wires the design system):
```tsx
import type { Metadata } from "next";

export const metadata: Metadata = { title: "GAIADA — ERP Suite" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`platform-ui/src/app/page.tsx`:
```tsx
export default function Home() {
  return <main>GAIADA ERP Suite</main>;
}
```

`platform-ui/README.md`:
```markdown
# Gaiada Platform UI (ERP Suite)

The web ERP surface for Gaiada and its child companies. Standalone Next.js project;
talks ONLY to the platform API (BFF pattern — the browser never sees tokens).

Design source: `../design/erp-suite-dashboard-handoff/` · Spec: `../docs/superpowers/specs/2026-07-05-gaiada-erp-ui-design.md`

## Run
1. `cp .env.example .env` and fill values (PLATFORM_SERVICE_TOKEN must match the platform's).
2. Start the platform (`cd ../platform && npm run dev`) with Postgres up.
3. `npm install && npm run dev` → http://localhost:3005

## Rules
Plain CSS design tokens only (no Tailwind). Zero radius, no shadows, 0.5px hairlines,
opacity-only hovers. UI never asserts identity or roles (D4/OBO); no secrets rendered.
```

- [ ] **Step 2: Install and verify dev server boots**

Run: `cd platform-ui && npm install && npx next build`
Expected: build succeeds (static home page).

- [ ] **Step 3: Verify vitest harness with a trivial test**

Create `platform-ui/src/smoke.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import Home from "./app/page";

it("renders the wordmark", () => {
  render(<Home />);
  expect(screen.getByText(/GAIADA ERP Suite/)).toBeInTheDocument();
});
```
Run: `cd platform-ui && npm test`
Expected: 1 test PASS. Then delete `src/smoke.test.tsx` (superseded by real component tests in Task 4).

- [ ] **Step 4: Commit**

```bash
git add platform-ui
git commit -m "feat(platform-ui): scaffold Next.js 15 project (port 3005) with vitest harness"
```

---

### Task 3: Port the design system (tokens, fonts, global CSS, GAIADA brand)

**Files:**
- Create: `platform-ui/src/styles/tokens/colors.css`, `.../tokens/typography.css`, `.../tokens/spacing.css`, `.../tokens/fonts.css` — copied from `design/erp-suite-dashboard-handoff/project/_ds/luxury-minimalist-design-system-*/tokens/` then adjusted as below
- Create: `platform-ui/public/fonts/CormorantGaramond-Bold.ttf`, `CormorantGaramond-Regular.ttf`, `Inter-Bold.woff`, `Inter-Regular.woff` — copied from the handoff `assets/fonts/`
- Create: `platform-ui/src/styles/globals.css`
- Modify: `platform-ui/src/app/layout.tsx`
- Test: `platform-ui/src/styles/tokens.test.ts`

**Interfaces:**
- Produces: CSS custom properties consumed by all components — `--font-display`, `--font-body`, `--surface-page`, `--surface-card`, `--text-primary`, `--accent` (`#6E5A43`), `--accent-secondary` (`#A39174`), `--hairline`, opacity tokens, spacing scale (`--space-10` … `--space-100`), `.type-eyebrow` utility class, `.erp-scroll` scrollbar class.

- [ ] **Step 1: Copy token files and fonts**

```bash
cd platform-ui
mkdir -p src/styles/tokens public/fonts
DS="../design/erp-suite-dashboard-handoff/project/_ds/luxury-minimalist-design-system-c156e5b1-7edc-4777-82f1-e102cdc8a274"
cp "$DS/tokens/colors.css" "$DS/tokens/typography.css" "$DS/tokens/spacing.css" src/styles/tokens/
cp "$DS/assets/fonts/"* public/fonts/
```

- [ ] **Step 2: Write fonts.css against self-hosted paths** (do not copy the handoff fonts.css — its paths differ)

`platform-ui/src/styles/tokens/fonts.css`:
```css
/* Self-hosted per design system: Cormorant Garamond (display), Inter (body). */
@font-face {
  font-family: "Cormorant Garamond";
  src: url("/fonts/CormorantGaramond-Regular.ttf") format("truetype");
  font-weight: 400; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "Cormorant Garamond";
  src: url("/fonts/CormorantGaramond-Bold.ttf") format("truetype");
  font-weight: 700; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "Inter";
  src: url("/fonts/Inter-Regular.woff") format("woff");
  font-weight: 400; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "Inter";
  src: url("/fonts/Inter-Bold.woff") format("woff");
  font-weight: 700; font-style: normal; font-display: swap;
}
:root {
  --font-display: "Cormorant Garamond", Georgia, serif;
  --font-body: "Inter", system-ui, sans-serif;
}
```

- [ ] **Step 3: Set the brand layer in the copied colors.css**

In `platform-ui/src/styles/tokens/colors.css`, change the two logo brand variables:
```css
  --brand-logo-text:       "GAIADA";
  --brand-logo-source:     none;
```
(Leave every other tier-1/2/3 value exactly as shipped — bronze accent stays.)

- [ ] **Step 4: Write globals.css (reset + ERP shell utilities from the prototype)**

`platform-ui/src/styles/globals.css`:
```css
@import "./tokens/fonts.css";
@import "./tokens/colors.css";
@import "./tokens/typography.css";
@import "./tokens/spacing.css";

/* Design-system hard rules: zero radius, no shadows, hairline borders, opacity hovers. */
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--surface-page); color: var(--text-primary); font-family: var(--font-body); }
button { font-family: inherit; }

:root {
  --erp-accent: var(--accent);
  --erp-accent2: var(--accent-secondary);
  --erp-hairline: rgba(26, 25, 22, 0.14);
  --erp-hairline-soft: rgba(26, 25, 22, 0.08);
  --erp-ink-60: rgba(26, 25, 22, 0.6);
  --erp-ink-50: rgba(26, 25, 22, 0.5);
  --erp-ease: cubic-bezier(0.22, 0.61, 0.36, 1);
}

/* Eyebrow — the system's signature editorial gesture (uppercase, 0.30em tracking). */
.type-eyebrow {
  font-family: var(--font-body);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.3em;
  text-transform: uppercase;
}

.erp-scroll::-webkit-scrollbar { width: 9px; height: 9px; }
.erp-scroll::-webkit-scrollbar-thumb { background: rgba(26, 25, 22, 0.16); }
.erp-scroll::-webkit-scrollbar-track { background: transparent; }

.erp-quiet { opacity: 0.6; transition: opacity 0.28s var(--erp-ease); }
.erp-quiet:hover { opacity: 1; }

@keyframes erp-fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes erp-toast { from { opacity: 0; transform: translate(-50%, 10px); } to { opacity: 1; transform: translate(-50%, 0); } }

:focus-visible { outline: 1px solid var(--erp-accent); outline-offset: 3px; }
```

- [ ] **Step 5: Wire into the root layout**

Replace `platform-ui/src/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "GAIADA — ERP Suite",
  description: "The Gaiada operating interface for all companies and departments.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 6: Token presence test**

`platform-ui/src/styles/tokens.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("design tokens", () => {
  it("brand layer is Gaiada with the bronze accent intact", () => {
    const colors = read("./tokens/colors.css");
    expect(colors).toContain('--brand-logo-text:       "GAIADA"');
    expect(colors).toContain("#6E5A43");
  });
  it("globals enforce the hairline + easing rules and never declare radius or shadows", () => {
    const globals = read("./globals.css");
    expect(globals).toContain("cubic-bezier(0.22, 0.61, 0.36, 1)");
    expect(globals).not.toMatch(/border-radius\s*:\s*[1-9]/);
    expect(globals).not.toContain("box-shadow");
  });
});
```
Run: `cd platform-ui && npm test` → PASS. Also `npx next build` → succeeds.

- [ ] **Step 7: Commit**

```bash
git add platform-ui/src/styles platform-ui/public/fonts platform-ui/src/app/layout.tsx
git commit -m "feat(platform-ui): port luxury-minimalist design system, GAIADA brand tokens, self-hosted fonts"
```

---

### Task 4: UI primitives (Eyebrow, Card, Button, StatusBadge, KpiTile, HairlineTable, LineChart, Toast)

**Files:**
- Create: `platform-ui/src/components/ui.tsx` (primitives share one focused file — they are ~15 lines each and always change together with the token contract)
- Create: `platform-ui/src/components/ui.css`
- Create: `platform-ui/src/components/LineChart.tsx`
- Test: `platform-ui/src/components/ui.test.tsx`

**Interfaces:**
- Produces (consumed by Tasks 6–8):
  - `Eyebrow({children, style?})` — span.type-eyebrow
  - `Card({children, title?, headerRight?, dark?, style?})` — paper surface, hairline border, 22px padding; `dark` renders the ink-black agenda variant
  - `Button({children, variant?: "solid"|"ghost", size?: "sm"|"md", onClick?, type?, disabled?})`
  - `StatusBadge({label})` — dot + uppercase label, color from `statusColor(label)`
  - `statusColor(s: string): string` — the prototype's status→color map
  - `KpiTile({label, value, delta?, deltaUp?, foot?})`
  - `HairlineTable({columns: {label: string, align?: "right"}[], rows: ReactNode[][]})`
  - `LineChart({series: number[], height?})` — the prototype's SVG area+line chart
  - `Toast({message})` — fixed bottom-center ink toast (render-if-present)

- [ ] **Step 1: Write the failing tests**

`platform-ui/src/components/ui.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Eyebrow, Card, Button, StatusBadge, statusColor, KpiTile, HairlineTable, Toast } from "./ui";
import { LineChart } from "./LineChart";

describe("ui primitives", () => {
  it("Eyebrow renders uppercase editorial class", () => {
    render(<Eyebrow>Workspace</Eyebrow>);
    expect(screen.getByText("Workspace")).toHaveClass("type-eyebrow");
  });

  it("Card renders title and children on the paper surface", () => {
    render(<Card title="Activity"><p>row</p></Card>);
    expect(screen.getByRole("heading", { name: "Activity" })).toBeInTheDocument();
    expect(screen.getByText("row")).toBeInTheDocument();
  });

  it("statusColor maps known statuses and falls back to accent", () => {
    expect(statusColor("Approved")).toBe("#4B7A5A");
    expect(statusColor("Overdue")).toBe("#B5622F");
    expect(statusColor("Anything else")).toBe("#6E5A43");
  });

  it("KpiTile shows label, value and delta", () => {
    render(<KpiTile label="Approvals pending" value="8" delta="+3" deltaUp foot="since yesterday" />);
    expect(screen.getByText("Approvals pending")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText(/\+3/)).toBeInTheDocument();
  });

  it("HairlineTable renders columns and rows", () => {
    render(
      <HairlineTable
        columns={[{ label: "Item" }, { label: "Status", align: "right" }]}
        rows={[["Budget memo", <StatusBadge key="s" label="Pending" />]]}
      />,
    );
    expect(screen.getByText("Item")).toBeInTheDocument();
    expect(screen.getByText("Budget memo")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("LineChart renders an svg path from the series", () => {
    const { container } = render(<LineChart series={[1, 2, 3]} />);
    expect(container.querySelector("svg path")).not.toBeNull();
  });

  it("Button variants carry the luxury classes", () => {
    render(<Button variant="ghost" size="sm">New</Button>);
    expect(screen.getByRole("button", { name: "New" }).className).toContain("lux-btn--ghost");
  });

  it("Toast renders the message", () => {
    render(<Toast message="Approved — routed to finance" />);
    expect(screen.getByText("Approved — routed to finance")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd platform-ui && npm test`
Expected: FAIL — module `./ui` not found.

- [ ] **Step 3: Implement `ui.css`**

`platform-ui/src/components/ui.css`:
```css
/* Primitives — every rule obeys: 0 radius, no shadow, hairlines, opacity hovers. */
.lux-card { background: var(--surface-card); border: 0.5px solid var(--erp-hairline); padding: 22px; display: flex; flex-direction: column; min-width: 0; }
.lux-card--dark { background: #1a1916; color: #f4f1ea; border-color: transparent; }
.lux-card__title { margin: 0; font-family: var(--font-display); font-weight: 700; font-size: 20px; }
.lux-card__head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 16px; }

.lux-btn { border: 0.5px solid var(--erp-accent); cursor: pointer; font-family: var(--font-body); font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; transition: opacity 0.28s var(--erp-ease); }
.lux-btn:disabled { opacity: 0.4; cursor: default; }
.lux-btn--solid { background: var(--erp-accent); color: #f4f1ea; }
.lux-btn--solid:hover:not(:disabled) { opacity: 0.55; }
.lux-btn--ghost { background: transparent; color: var(--text-primary); border-color: rgba(26, 25, 22, 0.3); }
.lux-btn--ghost:hover:not(:disabled) { background: rgba(110, 90, 67, 0.05); }
.lux-btn--sm { font-size: 11px; padding: 8px 14px; }
.lux-btn--md { font-size: 12px; padding: 11px 20px; }

.lux-badge { display: inline-flex; align-items: center; gap: 6px; font: 700 10px var(--font-body); letter-spacing: 0.08em; text-transform: uppercase; }
.lux-badge__dot { width: 6px; height: 6px; border-radius: 50%; } /* the dot is the system's one sanctioned circle */

.lux-kpi { background: var(--surface-card); border: 0.5px solid var(--erp-hairline); padding: 22px; display: flex; flex-direction: column; gap: 12px; }
.lux-kpi__value { font-family: var(--font-display); font-weight: 700; font-size: 32px; line-height: 1; }
.lux-kpi__delta { display: flex; align-items: center; gap: 6px; font: 400 12px var(--font-body); }

.lux-table { display: flex; flex-direction: column; min-width: 0; }
.lux-table__head, .lux-table__row { display: grid; grid-template-columns: var(--lux-tcols, 2fr 1fr 1fr 1fr); align-items: center; padding: 12px 22px; }
.lux-table__head { border-bottom: 0.5px solid var(--erp-hairline); padding-top: 0; padding-bottom: 9px; }
.lux-table__row { border-bottom: 0.5px solid var(--erp-hairline-soft); transition: background 0.2s var(--erp-ease); }
.lux-table__row:hover { background: rgba(110, 90, 67, 0.04); }
.lux-table__cell--right { justify-self: end; text-align: right; }

.lux-toast { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%); background: #1a1916; color: #f4f1ea; padding: 13px 22px; font: 400 13px var(--font-body); letter-spacing: 0.02em; z-index: 200; animation: erp-toast 0.28s var(--erp-ease); }
```

- [ ] **Step 4: Implement `ui.tsx`**

`platform-ui/src/components/ui.tsx`:
```tsx
import type { CSSProperties, ReactNode } from "react";
import "./ui.css";

export function Eyebrow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span className="type-eyebrow" style={style}>{children}</span>;
}

export function Card({ children, title, headerRight, dark, style }: {
  children: ReactNode; title?: string; headerRight?: ReactNode; dark?: boolean; style?: CSSProperties;
}) {
  return (
    <section className={`lux-card${dark ? " lux-card--dark" : ""}`} style={style}>
      {(title || headerRight) && (
        <div className="lux-card__head">
          {title ? <h3 className="lux-card__title">{title}</h3> : <span />}
          {headerRight}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({ children, variant = "solid", size = "sm", onClick, type = "button", disabled }: {
  children: ReactNode; variant?: "solid" | "ghost"; size?: "sm" | "md";
  onClick?: () => void; type?: "button" | "submit"; disabled?: boolean;
}) {
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`lux-btn lux-btn--${variant} lux-btn--${size}`}>
      {children}
    </button>
  );
}

// Prototype status→color map, verbatim.
const STATUS_COLORS: Record<string, string> = {
  Approved: "#4B7A5A", "On track": "#4B7A5A", Paid: "#4B7A5A", Active: "#4B7A5A", Shipped: "#4B7A5A",
  Open: "#6E5A43", Pending: "#6E5A43", Review: "#6E5A43",
  Draft: "#A39174",
  "At risk": "#B5622F", Overdue: "#B5622F", Low: "#B5622F", Critical: "#B5622F",
};
export function statusColor(s: string): string {
  return STATUS_COLORS[s] ?? "#6E5A43";
}

export function StatusBadge({ label }: { label: string }) {
  const color = statusColor(label);
  return (
    <span className="lux-badge" style={{ color }}>
      <span className="lux-badge__dot" style={{ background: color }} />
      {label}
    </span>
  );
}

export function KpiTile({ label, value, delta, deltaUp, foot }: {
  label: string; value: string; delta?: string; deltaUp?: boolean; foot?: string;
}) {
  return (
    <div className="lux-kpi">
      <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>{label}</Eyebrow>
      <div className="lux-kpi__value">{value}</div>
      {(delta || foot) && (
        <div className="lux-kpi__delta">
          {delta && (
            <span style={{ color: deltaUp ? "var(--erp-accent)" : "rgba(26,25,22,.45)", fontWeight: 700 }}>
              {deltaUp ? "▲ " : "▼ "}{delta}
            </span>
          )}
          {foot && <span style={{ color: "var(--erp-ink-50)" }}>{foot}</span>}
        </div>
      )}
    </div>
  );
}

export function HairlineTable({ columns, rows, tcols }: {
  columns: { label: string; align?: "right" }[];
  rows: ReactNode[][];
  tcols?: string;
}) {
  const style = tcols ? ({ "--lux-tcols": tcols } as CSSProperties) : undefined;
  return (
    <div className="lux-table" style={style}>
      <div className="lux-table__head">
        {columns.map((c) => (
          <Eyebrow key={c.label} style={{ fontSize: 10, opacity: 0.5, ...(c.align === "right" ? { justifySelf: "end" } : {}) }}>
            {c.label}
          </Eyebrow>
        ))}
      </div>
      {rows.map((cells, i) => (
        <div className="lux-table__row" key={i}>
          {cells.map((cell, j) => (
            <span key={j} className={columns[j]?.align === "right" ? "lux-table__cell--right" : undefined}
              style={{ font: j === 0 ? "400 14px var(--font-body)" : "400 13px var(--font-body)", color: j === 0 ? "var(--text-primary)" : "rgba(26,25,22,.65)" }}>
              {cell}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

export function Toast({ message }: { message: string }) {
  return <div className="lux-toast" role="status">{message}</div>;
}
```

- [ ] **Step 5: Implement `LineChart.tsx`** (port of the prototype's `buildChart`)

`platform-ui/src/components/LineChart.tsx`:
```tsx
export function LineChart({ series, height = 180 }: { series: number[]; height?: number }) {
  if (series.length < 2) return <svg style={{ width: "100%", height }} aria-hidden />;
  const w = 600, h = height, pad = 6;
  const max = Math.max(...series), min = Math.min(...series);
  const rng = max - min || 1, n = series.length;
  const xs = (i: number) => pad + i * ((w - 2 * pad) / (n - 1));
  const ys = (v: number) => h - pad - ((v - min) / rng) * (h - 2 * pad);
  const line = series.map((v, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)} ${ys(v).toFixed(1)}`).join(" ");
  const area = `${line} L${xs(n - 1).toFixed(1)} ${h} L${xs(0).toFixed(1)} ${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height, display: "block" }}>
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1={pad} x2={w - pad} y1={pad + g * (h - 2 * pad)} y2={pad + g * (h - 2 * pad)}
          stroke="#1A1916" strokeWidth={0.5} strokeOpacity={0.09} />
      ))}
      <path d={area} fill="var(--erp-accent, #6E5A43)" fillOpacity={0.09} />
      <path d={line} fill="none" stroke="var(--erp-accent, #6E5A43)" strokeWidth={1.6} />
      <circle cx={xs(n - 1)} cy={ys(series[n - 1])} r={3.2} fill="var(--erp-accent, #6E5A43)" />
    </svg>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd platform-ui && npm test`
Expected: all ui tests PASS.

- [ ] **Step 7: Commit**

```bash
git add platform-ui/src/components
git commit -m "feat(platform-ui): luxury primitives — card, button, badge, kpi, hairline table, line chart, toast"
```

---

### Task 5: Session auth + platform BFF client + login page

**Files:**
- Create: `platform-ui/src/lib/session.ts`, `platform-ui/src/lib/platform.ts`
- Create: `platform-ui/src/app/login/page.tsx`, `platform-ui/src/app/login/actions.ts`
- Create: `platform-ui/src/middleware.ts`
- Test: `platform-ui/src/lib/session.test.ts`, `platform-ui/src/lib/platform.test.ts`

**Interfaces:**
- Consumes: platform `GET /api/me` (Task 1).
- Produces (used by Tasks 6–8):
  - `sealSession(userId: string): string` / `openSession(cookieValue: string): string | null` — HMAC-signed cookie value, no deps (`node:crypto`)
  - `getSessionUserId(): Promise<string | null>` — reads the `gaiada_session` cookie (server-only)
  - `platformFetch<T>(path: string, userId: string, init?: RequestInit): Promise<T>` — adds `Authorization: Bearer $PLATFORM_SERVICE_TOKEN` + `x-user-id`; throws `PlatformError(status, message)` on non-2xx
  - `getMe(userId): Promise<Me>` with `type Me = { userId: string; name: string; email: string; title: string | null; assurance: string; companies: {id: string; name: string; type: string | null}[]; roles: {role: string; scopeType: string; scopeId: string | null}[] }`
  - Login flow: form posts email → server action asks platform to resolve the user (dev v1: `GET /api/me` cannot look up by email, so the action queries `GET /api/dev/user-by-email?email=` — see Step 5 platform addition) → sets cookie → redirect `/`
  - `middleware.ts` redirects unauthenticated requests to `/login` (except `/login`, `/_next`, `/fonts`)

- [ ] **Step 1: Write failing session tests**

`platform-ui/src/lib/session.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { sealSession, openSession } from "./session";

beforeAll(() => { process.env.SESSION_SECRET = "test-secret"; });

describe("session sealing", () => {
  it("round-trips a userId", () => {
    const sealed = sealSession("user-123");
    expect(openSession(sealed)).toBe("user-123");
  });
  it("rejects tampered values", () => {
    const sealed = sealSession("user-123");
    expect(openSession(sealed.replace("user-123", "user-666"))).toBeNull();
    expect(openSession("garbage")).toBeNull();
  });
});
```

- [ ] **Step 2: Implement `session.ts`**

`platform-ui/src/lib/session.ts`:
```ts
// HMAC-signed session cookie (v1-lite dev auth; the OIDC/IdP swap replaces this file).
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const COOKIE = "gaiada_session";

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  return s;
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

export function sealSession(userId: string): string {
  const payload = Buffer.from(userId).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function openSession(sealed: string): string | null {
  const [payload, sig] = sealed.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Buffer.from(payload, "base64url").toString();
}

export const SESSION_COOKIE = COOKIE;

export async function getSessionUserId(): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  return raw ? openSession(raw) : null;
}
```

Run: `npm test` → session tests PASS (the `cookies` import is unused in tests; if vitest complains about `next/headers` outside a request, split: keep `sealSession`/`openSession` pure in `session.ts` and move `getSessionUserId` to `session-server.ts` importing from it — tests target the pure file).

- [ ] **Step 3: Write failing platform-client tests**

`platform-ui/src/lib/platform.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { platformFetch, PlatformError } from "./platform";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://platform.test";
  process.env.PLATFORM_SERVICE_TOKEN = "svc-tok";
});

describe("platformFetch", () => {
  it("sends service token + acting user and parses JSON", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await platformFetch<{ ok: boolean }>("/api/me", "u-1");
    expect(out.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://platform.test/api/me");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer svc-tok");
    expect((init.headers as Record<string, string>)["x-user-id"]).toBe("u-1");
  });
  it("throws PlatformError with status on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not authorized" }), { status: 403 })));
    await expect(platformFetch("/api/x", "u-1")).rejects.toMatchObject({ status: 403 });
    await expect(platformFetch("/api/x", "u-1")).rejects.toBeInstanceOf(PlatformError);
  });
});
```

- [ ] **Step 4: Implement `platform.ts`**

`platform-ui/src/lib/platform.ts`:
```ts
// The ONLY backend this UI talks to. Server-side only — tokens never reach the browser.
export class PlatformError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function platformFetch<T>(path: string, userId: string, init: RequestInit = {}): Promise<T> {
  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.PLATFORM_SERVICE_TOKEN ?? ""}`,
      "x-user-id": userId,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = `platform ${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* keep default */ }
    throw new PlatformError(res.status, msg);
  }
  return (await res.json()) as T;
}

export interface Me {
  userId: string; name: string; email: string; title: string | null; assurance: string;
  companies: { id: string; name: string; type: string | null }[];
  roles: { role: string; scopeType: string; scopeId: string | null }[];
}

export const getMe = (userId: string) => platformFetch<Me>("/api/me", userId);
```

Run: `npm test` → platform tests PASS.

- [ ] **Step 5: Platform dev-login lookup endpoint**

In `platform/src/server.ts`, inside the `/api` block **before** the `userAuth` hook applies — actually add it OUTSIDE the core register block, next to `/principal/resolve` (service-auth only, no acting user):
```ts
  // Dev-auth v1 (recorded deviation, replaced by IdP): the UI's login exchanges an
  // email for a userId. Service-token-gated; returns only id+name (no secrets exist).
  app.get<{ Querystring: { email?: string } }>(
    "/dev/user-by-email",
    { preHandler: serviceAuth },
    async (req, reply) => {
      const email = req.query.email ?? "";
      if (!email) return reply.code(400).send({ error: "email required" });
      const rows = await withGlobal((c) =>
        c.query<{ id: string; name: string }>(
          `SELECT id, name FROM users WHERE email = $1 AND status = 'active' AND deleted_at IS NULL`,
          [email],
        ),
      );
      if (!rows.rows[0]) return reply.code(404).send({ error: "unknown user" });
      return rows.rows[0];
    },
  );
```
Add a test to `platform/src/me.api.test.ts`:
```ts
  it("dev login lookup resolves email → user id (service token required)", async () => {
    const ok = await app.inject({ method: "GET", url: "/dev/user-by-email?email=hansel@gaiada.com", headers: svc });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBe(hansel);
    const noAuth = await app.inject({ method: "GET", url: "/dev/user-by-email?email=hansel@gaiada.com" });
    expect(noAuth.statusCode).toBe(401);
  });
```
Run: `cd platform && npx vitest run src/me.api.test.ts` → PASS.

- [ ] **Step 6: Login page + server action + middleware**

`platform-ui/src/app/login/actions.ts`:
```ts
"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sealSession, SESSION_COOKIE } from "@/lib/session";

export async function login(_prev: { error: string } | null, formData: FormData): Promise<{ error: string }> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { error: "Enter your email to continue." };
  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  const res = await fetch(`${base}/dev/user-by-email?email=${encodeURIComponent(email)}`, {
    headers: { authorization: `Bearer ${process.env.PLATFORM_SERVICE_TOKEN ?? ""}` },
    cache: "no-store",
  });
  if (!res.ok) return { error: "We couldn't find that account. Check the address and try again." };
  const { id } = (await res.json()) as { id: string };
  const jar = await cookies();
  jar.set(SESSION_COOKIE, sealSession(id), { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/");
}
```

`platform-ui/src/app/login/page.tsx`:
```tsx
"use client";
import { useActionState } from "react";
import { login } from "./actions";
import { Eyebrow, Button } from "@/components/ui";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, null);
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--surface-page)" }}>
      <form action={action} style={{ width: 380, background: "var(--surface-card)", border: "0.5px solid var(--erp-hairline)", padding: 40, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 28, letterSpacing: "0.14em" }}>GAIADA</div>
          <Eyebrow style={{ opacity: 0.55, marginTop: 7, display: "block" }}>ERP Suite</Eyebrow>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Email</Eyebrow>
          <input name="email" type="email" autoComplete="email" required
            style={{ border: "none", borderBottom: "0.5px solid rgba(26,25,22,.22)", background: "transparent", outline: "none", padding: "8px 2px", font: "400 14px var(--font-body)", color: "var(--text-primary)" }} />
        </label>
        {state?.error && <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-accent)", opacity: 0.8 }}>{state.error}</p>}
        <Button type="submit" size="md" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</Button>
      </form>
    </main>
  );
}
```

`platform-ui/src/middleware.ts`:
```ts
import { NextResponse, type NextRequest } from "next/server";

// Edge runtime can't use node:crypto — presence check only here; every page
// verifies the HMAC server-side via getSessionUserId() before using the id.
export function middleware(req: NextRequest) {
  const isPublic = req.nextUrl.pathname.startsWith("/login");
  const hasSession = Boolean(req.cookies.get("gaiada_session")?.value);
  if (!isPublic && !hasSession) return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next|fonts|favicon.ico).*)"] };
```

- [ ] **Step 7: Verify build + tests, commit**

Run: `cd platform-ui && npm test && npx next build`
Expected: all tests PASS, build succeeds.
```bash
git add platform-ui/src/lib platform-ui/src/app/login platform-ui/src/middleware.ts platform/src/server.ts platform/src/me.api.test.ts
git commit -m "feat(platform-ui): HMAC session + BFF platform client + dev login (platform email lookup)"
```

---

### Task 6: App shell (sidebar nav, top bar, tenant switcher, user card)

**Files:**
- Create: `platform-ui/src/components/shell/Shell.tsx`, `Sidebar.tsx`, `TopBar.tsx`, `nav.ts`, `shell.css`, `icons.tsx`
- Create: `platform-ui/src/lib/tenant.ts`
- Create: `platform-ui/src/app/(app)/layout.tsx` (route group wrapping all authenticated pages)
- Modify: `platform-ui/src/app/page.tsx` → moved to `platform-ui/src/app/(app)/page.tsx` (placeholder; Task 7 fills it)
- Test: `platform-ui/src/components/shell/nav.test.ts`

**Interfaces:**
- Consumes: `getMe`, `getSessionUserId`.
- Produces:
  - `navFor(me: Me): NavGroup[]` with `type NavGroup = { label: string; items: NavItem[] }`, `type NavItem = { label: string; href: string; icon: IconName; adminOnly?: boolean }` — RBAC-gated: Admin group only when a role named `platform_admin` or `group_executive` is present; Rollups item only for `group_executive`/`platform_admin`; everything else visible to members (deny-by-default happens server-side on every call regardless)
  - `Shell({me, tenantId, children})` — the grid (`248px 1fr` columns, `64px 1fr` rows) with sidebar + top bar
  - `getActiveTenant(me): Promise<string>` / tenant switcher sets a `gaiada_tenant` cookie (plain value, validated against `me.companies` on read)
  - `Icon({name})` — inline stroke SVGs ported from the prototype (home, finance, sales, inventory, hr, manufacturing, procurement, projects, settings, search, bell, plus, check, x, wallet, pulse, box, clock, agents, knowledge, bot, gateway, hub, automation — new ones drawn in the same 1.6-stroke style)
- Nav structure (spec §4): Workspace (My Work `/`, Approvals `/approvals`) · Business (Companies `/companies`, Projects `/projects`, Tasks `/tasks`, Agency `/agency`, Rollups `/rollups`) · Intelligence (Knowledge `/knowledge`, AI Agents `/agents`) · Systems (Bot `/systems/bot`, AI Gateway `/systems/gateway`, MCP Hub `/systems/hub`, Automation `/systems/automation`) · Admin (`/admin/...` — Users & Roles, Identity Links, Modules & Custom Fields, Compliance Gates, Audit). Unbuilt pages route to a shared "quiet" placeholder — links render, pages say "This module arrives with a later plan." in the editorial voice.

- [ ] **Step 1: Write failing nav test**

`platform-ui/src/components/shell/nav.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { navFor } from "./nav";
import type { Me } from "@/lib/platform";

const base: Me = {
  userId: "u1", name: "Clement Hansel", email: "hansel@gaiada.com", title: "AI Manager",
  assurance: "high", companies: [{ id: "c1", name: "Gaiada HQ", type: null }], roles: [],
};

describe("navFor (RBAC-gated visibility)", () => {
  it("member sees Workspace/Business/Intelligence/Systems but no Admin, no Rollups", () => {
    const groups = navFor({ ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] });
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(["Workspace", "Business", "Intelligence", "Systems"]);
    const business = groups.find((g) => g.label === "Business")!;
    expect(business.items.map((i) => i.label)).not.toContain("Rollups");
  });
  it("platform_admin sees Admin group and Rollups", () => {
    const groups = navFor({ ...base, roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }] });
    expect(groups.map((g) => g.label)).toContain("Admin");
    const business = groups.find((g) => g.label === "Business")!;
    expect(business.items.map((i) => i.label)).toContain("Rollups");
  });
});
```
Run: `cd platform-ui && npm test` → FAIL (module not found).

- [ ] **Step 2: Implement `nav.ts`**

`platform-ui/src/components/shell/nav.ts`:
```ts
import type { Me } from "@/lib/platform";
import type { IconName } from "./icons";

export interface NavItem { label: string; href: string; icon: IconName }
export interface NavGroup { label: string; items: NavItem[] }

const ELEVATED = new Set(["platform_admin", "group_executive"]);

export function navFor(me: Me): NavGroup[] {
  const elevated = me.roles.some((r) => ELEVATED.has(r.role));
  const business: NavItem[] = [
    { label: "Companies", href: "/companies", icon: "finance" },
    { label: "Projects", href: "/projects", icon: "projects" },
    { label: "Tasks", href: "/tasks", icon: "check" },
    { label: "Agency", href: "/agency", icon: "sales" },
    ...(elevated ? [{ label: "Rollups", href: "/rollups", icon: "pulse" } as NavItem] : []),
  ];
  const groups: NavGroup[] = [
    { label: "Workspace", items: [
      { label: "My Work", href: "/", icon: "home" },
      { label: "Approvals", href: "/approvals", icon: "check" },
    ]},
    { label: "Business", items: business },
    { label: "Intelligence", items: [
      { label: "Knowledge", href: "/knowledge", icon: "box" },
      { label: "AI Agents", href: "/agents", icon: "agents" },
    ]},
    { label: "Systems", items: [
      { label: "WA/TG Bot", href: "/systems/bot", icon: "bot" },
      { label: "AI Gateway", href: "/systems/gateway", icon: "gateway" },
      { label: "MCP Hub", href: "/systems/hub", icon: "hub" },
      { label: "Automation", href: "/systems/automation", icon: "automation" },
    ]},
  ];
  if (elevated) {
    groups.push({ label: "Admin", items: [
      { label: "Users & Roles", href: "/admin/users", icon: "hr" },
      { label: "Identity Links", href: "/admin/identity", icon: "hub" },
      { label: "Modules & Fields", href: "/admin/modules", icon: "box" },
      { label: "Compliance Gates", href: "/admin/compliance", icon: "check" },
      { label: "Audit", href: "/admin/audit", icon: "clock" },
    ]});
  }
  return groups;
}
```
Run: `npm test` → nav tests PASS.

- [ ] **Step 3: Implement `icons.tsx`** — port the prototype's `ic()` map to a typed component. Every icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" width={s} height={s}>` with the exact path data from the prototype (`home, finance, sales, inventory, hr, manufacturing, procurement, projects, settings, search, bell, plus, check, x, wallet, pulse, box, clock`). Add four new same-style icons:
```
agents:     <circle cx=12 cy=8 r=3/> M5 21a7 7 0 0 1 14 0  M12 2v3
gateway:    M4 6h16v12H4z  M4 12h16  M9 6v12
hub:        <circle cx=12 cy=12 r=2.5/> M12 4v5 M12 15v5 M4 12h5 M15 12h5
bot:        M7 7h10v9H7z  M9 16v3 M15 16v3  M10 11h.01 M14 11h.01  M12 4v3
automation: <circle cx=12 cy=12 r=8/> M12 8v4l3 2
```
Export `type IconName = keyof typeof PATHS` and `Icon({ name, size = 19 })`.

- [ ] **Step 4: Implement `tenant.ts`, `shell.css`, `Sidebar.tsx`, `TopBar.tsx`, `Shell.tsx`**

`platform-ui/src/lib/tenant.ts`:
```ts
"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Me } from "./platform";

const COOKIE = "gaiada_tenant";

export async function getActiveTenant(me: Me): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (raw && me.companies.some((c) => c.id === raw)) return raw;
  return me.companies[0]?.id ?? null;
}

export async function switchTenant(formData: FormData): Promise<void> {
  const id = String(formData.get("tenantId") ?? "");
  const jar = await cookies();
  jar.set(COOKIE, id, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/");
}
```

`platform-ui/src/components/shell/shell.css`:
```css
.erp-app { display: grid; grid-template-columns: 248px 1fr; grid-template-rows: 64px 1fr; grid-template-areas: "side top" "side main"; height: 100vh; width: 100%; background: var(--surface-page); font-family: var(--font-body); }
.erp-side { grid-area: side; background: #f4f1ea; border-right: 0.5px solid var(--erp-hairline); display: flex; flex-direction: column; min-height: 0; }
.erp-side__brand { padding: 22px 22px 18px; border-bottom: 0.5px solid rgba(26, 25, 22, 0.1); }
.erp-side__wordmark { font-family: var(--font-display); font-weight: 700; font-size: 22px; line-height: 1; letter-spacing: 0.14em; color: var(--text-primary); }
.erp-side__nav { flex: 1; overflow-y: auto; padding: 16px 12px; min-height: 0; }
.erp-navbtn { display: flex; align-items: center; gap: 11px; padding: 9px 12px 9px 14px; border: none; background: transparent; cursor: pointer; width: 100%; text-align: left; position: relative; color: rgba(26, 25, 22, 0.62); transition: background 0.2s var(--erp-ease); text-decoration: none; font: 400 14px var(--font-body); }
.erp-navbtn:hover { background: rgba(110, 90, 67, 0.05); }
.erp-navbtn--active { background: rgba(110, 90, 67, 0.06); color: var(--text-primary); font-weight: 700; }
.erp-navbtn--active::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 2px; background: var(--erp-accent); }
.erp-side__user { border-top: 0.5px solid rgba(26, 25, 22, 0.1); padding: 14px 16px; display: flex; align-items: center; gap: 12px; }
.erp-side__avatar { width: 36px; height: 36px; background: var(--erp-accent); color: #f4f1ea; display: flex; align-items: center; justify-content: center; font-family: var(--font-display); font-weight: 700; font-size: 15px; }
.erp-top { grid-area: top; background: #f4f1ea; border-bottom: 0.5px solid var(--erp-hairline); display: flex; align-items: center; gap: 20px; padding: 0 26px; }
.erp-top__search { margin-left: 8px; flex: 1; max-width: 420px; display: flex; align-items: center; gap: 10px; border-bottom: 0.5px solid rgba(26, 25, 22, 0.22); padding: 8px 2px; }
.erp-top__search input { border: none; background: transparent; outline: none; width: 100%; font: 400 14px var(--font-body); color: var(--text-primary); }
.erp-main { grid-area: main; overflow-y: auto; min-height: 0; background: var(--surface-page); }
.erp-main__inner { padding: 30px 32px 40px; }
.erp-tenant select { border: none; background: transparent; font: 400 13px var(--font-body); color: var(--erp-ink-60); cursor: pointer; }
```

`Sidebar.tsx` (server component):
```tsx
import Link from "next/link";
import type { Me } from "@/lib/platform";
import { navFor } from "./nav";
import { Icon } from "./icons";
import { Eyebrow } from "@/components/ui";

export function Sidebar({ me, activePath }: { me: Me; activePath: string }) {
  const initials = me.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <aside className="erp-side">
      <div className="erp-side__brand">
        <div className="erp-side__wordmark">GAIADA</div>
        <Eyebrow style={{ marginTop: 7, opacity: 0.55, display: "block" }}>ERP Suite</Eyebrow>
      </div>
      <nav className="erp-side__nav erp-scroll">
        {navFor(me).map((group) => (
          <div key={group.label}>
            <Eyebrow style={{ padding: "22px 10px 10px", opacity: 0.4, fontSize: 10, display: "block" }}>{group.label}</Eyebrow>
            {group.items.map((item) => (
              <Link key={item.href} href={item.href}
                className={`erp-navbtn${activePath === item.href ? " erp-navbtn--active" : ""}`}>
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="erp-side__user">
        <div className="erp-side__avatar">{initials}</div>
        <div style={{ minWidth: 0, lineHeight: 1.25 }}>
          <div style={{ font: "700 13px var(--font-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{me.name}</div>
          <div style={{ font: "400 11px var(--font-body)", color: "rgba(26,25,22,.55)" }}>{me.title ?? me.email}</div>
        </div>
      </div>
    </aside>
  );
}
```

`TopBar.tsx` (server component; search is display-only this plan — global search wires up with the module pages):
```tsx
import type { Me } from "@/lib/platform";
import { switchTenant } from "@/lib/tenant";
import { Icon } from "./icons";
import { Eyebrow } from "@/components/ui";

export function TopBar({ me, tenantId, moduleLabel }: { me: Me; tenantId: string | null; moduleLabel: string }) {
  const dateLine = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  return (
    <header className="erp-top">
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
        <Eyebrow style={{ color: "var(--erp-accent)" }}>{moduleLabel}</Eyebrow>
        <span style={{ width: 0.5, height: 16, background: "rgba(26,25,22,.2)" }} />
        <span style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-60)", whiteSpace: "nowrap" }}>{dateLine}</span>
      </div>
      <label className="erp-top__search">
        <Icon name="search" size={18} />
        <input placeholder="Search records, people, approvals…" aria-label="Search" />
      </label>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 18 }}>
        {me.companies.length > 1 && (
          <form action={switchTenant} className="erp-tenant">
            <select name="tenantId" defaultValue={tenantId ?? undefined} aria-label="Company">
              {me.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <noscript><button type="submit">Switch</button></noscript>
          </form>
        )}
      </div>
    </header>
  );
}
```
(Note: a `<select>` in a server-component form needs a submit; add a small client wrapper that submits `switchTenant` onChange — implementer: make `TenantSwitcher` a `"use client"` child calling the server action via `formAction`.)

`Shell.tsx`:
```tsx
import type { ReactNode } from "react";
import type { Me } from "@/lib/platform";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import "./shell.css";

export function Shell({ me, tenantId, activePath, moduleLabel, children }: {
  me: Me; tenantId: string | null; activePath: string; moduleLabel: string; children: ReactNode;
}) {
  return (
    <div className="erp-app">
      <Sidebar me={me} activePath={activePath} />
      <TopBar me={me} tenantId={tenantId} moduleLabel={moduleLabel} />
      <main className="erp-main erp-scroll"><div className="erp-main__inner">{children}</div></main>
    </div>
  );
}
```

`platform-ui/src/app/(app)/layout.tsx`:
```tsx
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { Shell } from "@/components/shell/Shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId).catch(() => null);
  if (!me) redirect("/login");
  const tenantId = await getActiveTenant(me);
  return (
    <Shell me={me} tenantId={tenantId} activePath="/" moduleLabel="My Workspace">
      {children}
    </Shell>
  );
}
```
(`activePath` from a layout can't see the child route in App Router — implementer: derive active state client-side in a tiny `"use client"` `NavLink` using `usePathname()` instead of passing `activePath`; adjust `Sidebar` accordingly. This is the known-correct App Router pattern.)

Move `src/app/page.tsx` → `src/app/(app)/page.tsx` (placeholder content until Task 7).

- [ ] **Step 5: Placeholder route pages** — create `src/app/(app)/[...placeholder]/page.tsx`:
```tsx
import { Eyebrow } from "@/components/ui";

export default function Placeholder() {
  return (
    <div style={{ padding: "60px 0", textAlign: "center" }}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 22 }}>Not yet furnished</div>
      <p style={{ font: "400 14px var(--font-body)", color: "var(--erp-ink-60)", marginTop: 10 }}>
        This module arrives with a later plan. Your navigation is already real.
      </p>
      <Eyebrow style={{ opacity: 0.4, marginTop: 20, display: "block" }}>GAIADA · ERP Suite</Eyebrow>
    </div>
  );
}
```

- [ ] **Step 6: Verify** — `npm test` (nav tests pass) and `npx next build`, then run `npm run dev` against a locally running platform: log in as a seeded user, confirm shell renders with nav groups, user card, tenant switcher.

- [ ] **Step 7: Commit**

```bash
git add platform-ui/src
git commit -m "feat(platform-ui): authenticated app shell — sidebar nav (RBAC-gated), top bar, tenant switcher, user card"
```

---

### Task 7: My Work dashboard (real data)

**Files:**
- Create: `platform-ui/src/app/(app)/page.tsx` (replace placeholder), `platform-ui/src/app/(app)/actions.ts`, `platform-ui/src/components/dashboard/ApprovalsPanel.tsx`, `platform-ui/src/components/dashboard/dashboard.css`
- Create: `platform-ui/src/lib/data.ts`
- Test: `platform-ui/src/components/dashboard/ApprovalsPanel.test.tsx`, `platform-ui/src/lib/data.test.ts`

**Interfaces:**
- Consumes: `platformFetch`, Task 1 endpoints, agency endpoints (`GET /api/:t/modules/agency/approvals/pending`, `POST /api/:t/modules/agency/approvals/:id/decide`).
- Produces:
  - `lib/data.ts`: `getPendingApprovals(userId, tenantIds): Promise<ApprovalItem[]>` (fans out across the user's tenants; a tenant where the module is disabled → 404 → skipped, not fatal), `getMyTasks(userId, tenantId)`, `getActivity(userId, tenantId)`, `weeklyThroughput(activity: {occurred_at: string}[]): number[]` (buckets the last 8 ISO weeks, oldest→newest)
  - `type ApprovalItem = { id: string; tenantId: string; company: string; subject: string; campaign: string; created_at: string }`
  - Server action `decideApproval(tenantId: string, approvalId: string, decision: "approved"|"rejected")` → calls the platform, `revalidatePath("/")`
  - `ApprovalsPanel({items, decide})` — client component: approve/decline square buttons per the prototype, optimistic removal + toast, "All clear" empty state with the exact copy "All clear — nothing awaiting your review right now."

- [ ] **Step 1: Write failing tests for the pure logic**

`platform-ui/src/lib/data.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPendingApprovals, weeklyThroughput } from "./data";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
});

describe("weeklyThroughput", () => {
  it("buckets activity into 8 weekly counts, oldest first", () => {
    const now = Date.now();
    const wk = 7 * 24 * 3600 * 1000;
    const rows = [
      { occurred_at: new Date(now - 0.5 * wk).toISOString() },
      { occurred_at: new Date(now - 0.6 * wk).toISOString() },
      { occurred_at: new Date(now - 2.5 * wk).toISOString() },
    ];
    const series = weeklyThroughput(rows);
    expect(series).toHaveLength(8);
    expect(series[7]).toBe(2);
    expect(series[5]).toBe(1);
  });
});

describe("getPendingApprovals", () => {
  it("skips tenants where the agency module is disabled (404) instead of failing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/t-on/")) {
        return new Response(JSON.stringify([{ id: "a1", subject: "Banner v2", campaign: "Launch", created_at: "2026-07-01" }]), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "module agency not enabled" }), { status: 404 });
    }));
    const items = await getPendingApprovals("u1", [
      { id: "t-on", name: "Agency A" },
      { id: "t-off", name: "Resort B" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "a1", tenantId: "t-on", company: "Agency A" });
  });
});
```

- [ ] **Step 2: Run to verify fail, then implement `lib/data.ts`**

```ts
import { platformFetch, PlatformError } from "./platform";

export interface ApprovalItem { id: string; tenantId: string; company: string; subject: string; campaign: string; created_at: string }
export interface TaskRow { id: string; title: string; status: string | null; priority: string | null; due_date: string | null; project_name: string }
export interface ActivityRow { id: string; actor_name: string | null; verb: string; target_entity_type: string; metadata: Record<string, unknown>; occurred_at: string }

export async function getPendingApprovals(userId: string, tenants: { id: string; name: string }[]): Promise<ApprovalItem[]> {
  const per = await Promise.all(
    tenants.map(async (t) => {
      try {
        const rows = await platformFetch<Omit<ApprovalItem, "tenantId" | "company">[]>(
          `/api/${t.id}/modules/agency/approvals/pending`, userId,
        );
        return rows.map((r) => ({ ...r, tenantId: t.id, company: t.name }));
      } catch (e) {
        if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return [];
        throw e;
      }
    }),
  );
  return per.flat().sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export const getMyTasks = (userId: string, tenantId: string) =>
  platformFetch<TaskRow[]>(`/api/${tenantId}/tasks?assignee=me`, userId);

export const getActivity = (userId: string, tenantId: string, limit = 20) =>
  platformFetch<ActivityRow[]>(`/api/${tenantId}/activity?limit=${limit}`, userId);

export function weeklyThroughput(rows: { occurred_at: string }[], weeks = 8): number[] {
  const wk = 7 * 24 * 3600 * 1000;
  const now = Date.now();
  const series = new Array(weeks).fill(0);
  for (const r of rows) {
    const age = Math.floor((now - Date.parse(r.occurred_at)) / wk);
    if (age >= 0 && age < weeks) series[weeks - 1 - age] += 1;
  }
  return series;
}
```
Run: `npm test` → data tests PASS.

- [ ] **Step 3: Server action**

`platform-ui/src/app/(app)/actions.ts`:
```ts
"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session";
import { platformFetch } from "@/lib/platform";

export async function decideApproval(tenantId: string, approvalId: string, decision: "approved" | "rejected"): Promise<{ ok: boolean; error?: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  try {
    await platformFetch(`/api/${tenantId}/modules/agency/approvals/${approvalId}/decide`, userId, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath("/");
  revalidatePath("/approvals");
  return { ok: true };
}
```

- [ ] **Step 4: ApprovalsPanel (client) + test**

`platform-ui/src/components/dashboard/ApprovalsPanel.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ApprovalsPanel } from "./ApprovalsPanel";

const items = [
  { id: "a1", tenantId: "t1", company: "Agency A", subject: "Banner v2", campaign: "Launch", created_at: "2026-07-01" },
];

describe("ApprovalsPanel", () => {
  it("renders pending items with approve/decline controls", () => {
    render(<ApprovalsPanel items={items} decide={vi.fn(async () => ({ ok: true }))} />);
    expect(screen.getByText("Banner v2")).toBeInTheDocument();
    expect(screen.getByTitle("Approve")).toBeInTheDocument();
    expect(screen.getByTitle("Decline")).toBeInTheDocument();
  });
  it("optimistically removes an item and shows the empty state after the last decision", async () => {
    const decide = vi.fn(async () => ({ ok: true }));
    render(<ApprovalsPanel items={items} decide={decide} />);
    fireEvent.click(screen.getByTitle("Approve"));
    await waitFor(() => expect(screen.queryByText("Banner v2")).not.toBeInTheDocument());
    expect(decide).toHaveBeenCalledWith("t1", "a1", "approved");
    expect(screen.getByText(/All clear/)).toBeInTheDocument();
  });
});
```

`platform-ui/src/components/dashboard/ApprovalsPanel.tsx`:
```tsx
"use client";
import { useState } from "react";
import type { ApprovalItem } from "@/lib/data";
import { Icon } from "@/components/shell/icons";
import { Toast } from "@/components/ui";
import "./dashboard.css";

type Decide = (tenantId: string, approvalId: string, decision: "approved" | "rejected") => Promise<{ ok: boolean; error?: string }>;

export function ApprovalsPanel({ items, decide }: { items: ApprovalItem[]; decide: Decide }) {
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const visible = items.filter((i) => !gone.has(i.id));

  async function act(item: ApprovalItem, decision: "approved" | "rejected") {
    setGone((g) => new Set(g).add(item.id)); // optimistic
    const res = await decide(item.tenantId, item.id, decision);
    if (!res.ok) {
      setGone((g) => { const n = new Set(g); n.delete(item.id); return n; });
      setToast(res.error ?? "That decision didn't go through — please try again.");
    } else {
      setToast(decision === "approved" ? "Approved — the requester has been notified." : "Declined — the requester has been notified.");
    }
    setTimeout(() => setToast(null), 2200);
  }

  if (visible.length === 0) {
    return (
      <div className="dash-empty">
        <div style={{ fontFamily: "var(--font-display)", fontSize: 18 }}>All clear</div>
        <p>Nothing awaiting your review right now.</p>
      </div>
    );
  }
  return (
    <div>
      {visible.map((t) => (
        <div key={t.id} className="dash-approval">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="dash-approval__title">{t.subject}</div>
            <div className="dash-approval__meta">{t.company} · {t.campaign}</div>
          </div>
          <div className="dash-approval__actions">
            <button title="Approve" className="dash-approval__btn dash-approval__btn--solid" onClick={() => act(t, "approved")}><Icon name="check" size={14} /></button>
            <button title="Decline" className="dash-approval__btn" onClick={() => act(t, "rejected")}><Icon name="x" size={14} /></button>
          </div>
        </div>
      ))}
      {toast && <Toast message={toast} />}
    </div>
  );
}
```

`platform-ui/src/components/dashboard/dashboard.css`:
```css
.dash-grid { display: grid; gap: 20px; grid-template-columns: 1.7fr 1fr; grid-template-areas: "kpi kpi" "chart tasks" "table activity"; }
.dash-kpis { grid-area: kpi; display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
.dash-approval { padding: 13px 0; border-top: 0.5px solid rgba(26, 25, 22, 0.1); display: flex; gap: 12px; align-items: flex-start; }
.dash-approval__title { font: 400 14px/1.35 var(--font-body); color: var(--text-primary); }
.dash-approval__meta { font: 400 12px var(--font-body); color: rgba(26, 25, 22, 0.55); margin-top: 3px; }
.dash-approval__actions { display: flex; gap: 6px; }
.dash-approval__btn { width: 26px; height: 26px; border: 0.5px solid rgba(26, 25, 22, 0.3); background: transparent; color: var(--text-primary); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.dash-approval__btn--solid { border-color: var(--erp-accent); background: var(--erp-accent); color: #f4f1ea; }
.dash-empty { padding: 26px 0; text-align: center; }
.dash-empty p { font: 400 13px var(--font-body); color: rgba(26, 25, 22, 0.55); margin-top: 6px; }
.dash-pending-chip { font: 700 11px var(--font-body); letter-spacing: 0.06em; color: var(--erp-accent); border: 0.5px solid var(--erp-accent); padding: 4px 9px; }
.dash-activity-row { display: flex; gap: 12px; padding-bottom: 16px; }
.dash-activity-dot { display: flex; flex-direction: column; align-items: center; }
.dash-activity-dot span:first-child { width: 8px; height: 8px; border-radius: 50%; background: var(--erp-accent); margin-top: 5px; }
.dash-activity-dot span:last-child { flex: 1; width: 0.5px; background: var(--erp-hairline); margin-top: 5px; }
@media (max-width: 1100px) { .dash-grid { grid-template-columns: 1fr; grid-template-areas: "kpi" "chart" "tasks" "table" "activity"; } }
```

Run: `npm test` → panel tests PASS.

- [ ] **Step 5: The page**

`platform-ui/src/app/(app)/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPendingApprovals, getMyTasks, getActivity, weeklyThroughput } from "@/lib/data";
import { decideApproval } from "./actions";
import { Card, Eyebrow, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { LineChart } from "@/components/LineChart";
import { ApprovalsPanel } from "@/components/dashboard/ApprovalsPanel";

function timeOfDay(): string {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

export default async function MyWork() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenantId = await getActiveTenant(me);
  const firstName = me.name.split(/\s+/)[0];

  const [approvals, tasks, activity] = await Promise.all([
    getPendingApprovals(userId, me.companies),
    tenantId ? getMyTasks(userId, tenantId) : Promise.resolve([]),
    tenantId ? getActivity(userId, tenantId) : Promise.resolve([]),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const dueToday = tasks.filter((t) => t.due_date && t.due_date.slice(0, 10) <= today).length;
  const series = weeklyThroughput(activity);

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 26 }}>
        <div>
          <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Personal home</Eyebrow>
          <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1 }}>
            Good {timeOfDay()}, {firstName}
          </h1>
          <p style={{ margin: "9px 0 0", font: "400 15px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)", maxWidth: 560 }}>
            {approvals.length > 0
              ? `You have ${approvals.length} item${approvals.length === 1 ? "" : "s"} awaiting review and ${dueToday} task${dueToday === 1 ? "" : "s"} due today. Here is your brief.`
              : "Nothing is waiting on you right now. Here is your brief."}
          </p>
        </div>
      </div>

      <div className="dash-grid">
        <section className="dash-kpis">
          <KpiTile label="Approvals pending" value={String(approvals.length)} foot="across your companies" deltaUp={approvals.length === 0} />
          <KpiTile label="Tasks due" value={String(dueToday)} foot="today or overdue" />
          <KpiTile label="Assigned to you" value={String(tasks.length)} foot="open tasks" />
          <KpiTile label="Companies" value={String(me.companies.length)} foot="in your scope" />
        </section>

        <Card title="Your throughput" headerRight={<Eyebrow style={{ fontSize: 10, opacity: 0.5 }}>Last 8 weeks</Eyebrow>} style={{ gridArea: "chart" }}>
          <LineChart series={series} />
        </Card>

        <Card title="Awaiting you" style={{ gridArea: "tasks" }}
          headerRight={<span className="dash-pending-chip">{approvals.length} PENDING</span>}>
          <ApprovalsPanel items={approvals} decide={decideApproval} />
        </Card>

        <Card title="Assigned to you" style={{ gridArea: "table", padding: "22px 0 8px" }}>
          {tasks.length === 0 ? (
            <div className="dash-empty"><p>No open tasks assigned to you in this company.</p></div>
          ) : (
            <HairlineTable
              tcols="2.2fr 1.2fr 1fr 1fr"
              columns={[{ label: "Task" }, { label: "Project" }, { label: "Due" }, { label: "Status", align: "right" }]}
              rows={tasks.slice(0, 8).map((t) => [
                t.title, t.project_name, t.due_date ? t.due_date.slice(0, 10) : "—",
                <StatusBadge key={t.id} label={t.status ?? "Open"} />,
              ])}
            />
          )}
        </Card>

        <Card title="Activity" style={{ gridArea: "activity" }}>
          {activity.length === 0 ? (
            <div className="dash-empty"><p>Quiet so far — activity appears here as work happens.</p></div>
          ) : activity.slice(0, 6).map((a) => (
            <div key={a.id} className="dash-activity-row">
              <div className="dash-activity-dot"><span /><span /></div>
              <div style={{ minWidth: 0 }}>
                <div style={{ font: "400 13px/1.45 var(--font-body)" }}>
                  <b style={{ fontWeight: 700 }}>{a.actor_name ?? "System"}</b> {a.verb} {a.target_entity_type.replace(/_/g, " ")}
                </div>
                <div style={{ font: "400 11px var(--font-body)", color: "rgba(26,25,22,.5)", marginTop: 3 }}>
                  {new Date(a.occurred_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}
```
Note: the Card padding override for the table uses `style` — the Card must spread `style` after its defaults (it does, Task 4).

- [ ] **Step 6: Verify against the live platform** — with platform + PG running and seed data (create a company, Hansel user with title 'AI Manager', membership, manager role, agency module enabled, a campaign + pending approval, a task assigned to Hansel — write a small seed script `platform/scripts/seed-dev.ts` using the fixtures if none exists), log in and confirm: greeting "Good …, Clement", 4 KPIs real, approvals panel decides and audits, table + activity populated.

- [ ] **Step 7: Run all tests + build, commit**

```bash
cd platform-ui && npm test && npx next build
git add platform-ui/src platform/scripts 2>/dev/null
git commit -m "feat(platform-ui): My Work dashboard — real KPIs, approvals panel with decide action, tasks, activity, throughput chart"
```

---

### Task 8: Approvals page (unified inbox v1)

**Files:**
- Create: `platform-ui/src/app/(app)/approvals/page.tsx`
- Test: covered by ApprovalsPanel tests (reused component); page-level render is verified in the live check

**Interfaces:**
- Consumes: `getPendingApprovals` (all tenants), `decideApproval`, `ApprovalsPanel`.
- Produces: `/approvals` route — full-width inbox grouped by company; later plans add agent-suspension and identity-link sources to `getPendingApprovals`-style aggregators feeding this same page.

- [ ] **Step 1: Implement the page**

`platform-ui/src/app/(app)/approvals/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session";
import { getMe } from "@/lib/platform";
import { getPendingApprovals } from "@/lib/data";
import { decideApproval } from "../actions";
import { Card, Eyebrow } from "@/components/ui";
import { ApprovalsPanel } from "@/components/dashboard/ApprovalsPanel";

export default async function ApprovalsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const approvals = await getPendingApprovals(userId, me.companies);
  const byCompany = new Map<string, typeof approvals>();
  for (const a of approvals) {
    const list = byCompany.get(a.company) ?? [];
    list.push(a);
    byCompany.set(a.company, list);
  }

  return (
    <>
      <div style={{ marginBottom: 26 }}>
        <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Workspace</Eyebrow>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1 }}>Approvals</h1>
        <p style={{ margin: "9px 0 0", font: "400 15px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)", maxWidth: 560 }}>
          Everything awaiting your decision, across every company. Agent and identity requests join this inbox as those systems come online.
        </p>
      </div>
      {byCompany.size === 0 ? (
        <Card><div className="dash-empty">
          <div style={{ fontFamily: "var(--font-display)", fontSize: 18 }}>All clear</div>
          <p>Nothing awaiting your review right now.</p>
        </div></Card>
      ) : (
        <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))" }}>
          {[...byCompany.entries()].map(([company, items]) => (
            <Card key={company} title={company} headerRight={<span className="dash-pending-chip">{items.length} PENDING</span>}>
              <ApprovalsPanel items={items} decide={decideApproval} />
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Verify live** — seed a second pending approval, load `/approvals`, decide one, confirm the platform's `agency_approvals.status` changed and an activity row was written (query PG or check the dashboard's activity feed).

- [ ] **Step 3: Run tests + build, commit**

```bash
cd platform-ui && npm test && npx next build
git add platform-ui/src/app
git commit -m "feat(platform-ui): approvals inbox — cross-company pending approvals with inline decisions"
```

---

### Task 9: Dockerfile, compose entry, docs sync

**Files:**
- Create: `platform-ui/Dockerfile`, `platform-ui/.dockerignore`
- Modify: `infra/compose/docker-compose.vps.yml` (add `platform-ui` service)
- Modify: `CLAUDE.md` (status section), `docs/superpowers/plans/2026-07-05-CHECKLIST.md` (add ERP-UI section), `README.md` (component map — follow its existing format)

**Interfaces:**
- Produces: `platform-ui` container on port 3005 wired to the internal `platform` service.

- [ ] **Step 1: Dockerfile** (match the style of the other components' Dockerfiles — check `platform/Dockerfile` first and mirror its base image/user conventions):
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3005
CMD ["node", "server.js"]
```
Requires `output: "standalone"` in `next.config.ts`:
```ts
const nextConfig: NextConfig = { output: "standalone" };
```
`.dockerignore`: `node_modules`, `.next`, `.env`.

- [ ] **Step 2: Compose entry** — in `infra/compose/docker-compose.vps.yml`, following the existing services' pattern (env style, networks, restart policy):
```yaml
  platform-ui:
    build: ../../platform-ui
    restart: unless-stopped
    environment:
      PLATFORM_URL: http://platform:3004
      PLATFORM_SERVICE_TOKEN: ${PLATFORM_SERVICE_TOKEN}
      SESSION_SECRET: ${UI_SESSION_SECRET}
    ports:
      - "3005:3005"
    depends_on:
      - platform
```

- [ ] **Step 3: Verify the image builds**: `cd platform-ui && docker build -t gaiada-platform-ui .` (skip gracefully if Docker is unavailable locally — note it in the commit message).

- [ ] **Step 4: Docs** — add to `CLAUDE.md` current status: a `platform-ui/` bullet (Next.js ERP Suite UI, plan-1 scope live, spec + plan paths). Add a "Phase 5 — ERP UI" section to the CHECKLIST marking plan-1 tasks done and listing plans 2–4 as next. Add the component to `README.md`'s folder map.

- [ ] **Step 5: Commit**

```bash
git add platform-ui/Dockerfile platform-ui/.dockerignore platform-ui/next.config.ts infra/compose/docker-compose.vps.yml CLAUDE.md README.md docs/superpowers/plans/2026-07-05-CHECKLIST.md
git commit -m "feat(platform-ui): Dockerfile + VPS compose entry; docs sync (ERP UI plan 1 complete)"
```

---

## Follow-up plans (not in this document)

- **Plan 2 — Business modules:** Companies/Projects/Tasks/Agency pages (lists, detail, create/edit with D17 custom fields), Rollups page.
- **Plan 3 — Admin APIs + Systems pages:** the uniform `GET/PUT /admin/*` contract in bot → gateway → agents → hub → knowledge, platform proxy `/api/admin/:system/*`, Systems settings pages.
- **Plan 4 — Admin section + step-up:** users/roles/identity-links/module-enable/compliance/audit pages, `/step-up` landing (D4), session revocation UI (D11).
- **Plan 5 — Polish:** layout presets, density toggle, a11y audit, Playwright e2e suite.
