# IAM-06 — Test personas & fixtures

**Status: PROTOTYPED.** This is the thing PM and Web Dev actually consume — if a helper here
needs more than the copy-paste example below to use correctly, that's a bug in the helper, not in
your understanding of it.

Two halves:
- **IAM-06a** — `src/seed/personas.ts`. Plants one real, durable user per role tier in whatever
  database `DATABASE_URL` points at (dev box, staging). Log in as any of them by email.
- **IAM-06b** — `src/testing/personas.ts` (backend) + `platform-ui/e2e/personas.ts` (Playwright).
  One-line persona access **inside a test**, seeded fresh into a throwaway tenant every run —
  never depends on IAM-06a having been run against that database.

You almost certainly want **IAM-06b** if you're writing a test. Reach for IAM-06a only when you
want to click around a real UI/API by hand as a given role.

---

## The personas

| Key | Role granted | Scope | Notes |
|---|---|---|---|
| `superadmin` | `platform_admin` | global | everything, everywhere |
| `company_admin` | `company_admin` | company | administers the persona tenant |
| `manager` | `manager` | company | |
| `team_lead` | `team_lead` | **team** | scoped to a team, NOT the whole company — see ⚠ below |
| `member` | `member` | company | baseline |
| `viewer` | `viewer` | company | read-only baseline |
| `hr_staff` | `hr_staff` | company | HR module |
| `hr_manager` | `hr_manager` | company | HR module |
| `it_admin` | `it_admin` | company | IT module |
| `search_staff` | `search_staff` | company | search/SEO module |
| `search_manager` | `search_manager` | company | search/SEO module |
| `agency_approver` | `agency_approver` **+** `member` | company | mirrors `seed:agency`'s pattern — holds both |
| `group_executive` | `group_executive` | global | ⚠ **OBSOLETE (D-7)** — see below |
| `client_contact` | *(none — `client_contacts` row)* | client, portal-only | ⚠ NOT a staff role — see below |

### ⚠ Two personas that need reading before you use them

- **`group_executive` is slated for removal.** The 2026-08-10 identity/RBAC program (D-7) marks
  this role OBSOLETE; Phase 3 removes it. It is seeded here because it **exists today** — treat any
  test built against it as temporary scaffolding, not a permanent fixture. It is **not** a stand-in
  for the future `owner` role (D-8): `owner`'s envelope (all business ops, no platform/system
  controls) is deliberately narrower than what `group_executive` holds today. **There is no `owner`
  persona** — the role isn't built yet, and inventing a fixture for a role that doesn't exist would
  quietly teach you to test against a fiction. When IAM-14 ships `owner`, it gets added as a new
  key; it will not repurpose `group_executive`'s.

- **`client_contact` is portal-only, structurally.** Clients live in `client_contacts`,
  **deliberately not** `company_memberships` — see the long comment at the top of
  `src/rbac/principal.ts`. That table is what every staff-listing query filters on; a client row
  there would eventually leak into `/people` or HR as if they were an employee. If you're testing
  a staff-facing surface, this persona should be **denied**, not merely "different" — a 200 here on
  a staff endpoint is a bug, not a quirk.

- **`team_lead` does not blanket-cover company resources.** Its Cerbos derived role only activates
  when the resource itself carries a matching `teamId` attribute (`derived_roles.yaml`). A
  company-wide resource with no team concept (e.g. the IT device registry) denies `team_lead`
  even though the resource's OWN policy lists `team_lead` in its read rule — the rule only fires
  when the attribute condition holds too. `src/testing/personas.test.ts` has a worked example.

---

## Backend — one line in an integration test (IAM-06b)

```ts
import { seedPersonaTenant } from "../../testing/personas";

const p = await seedPersonaTenant();               // seeds ALL 14 personas in a fresh tenant
// or: await seedPersonaTenant(["it_admin", "viewer"]);  // just the ones you need

// ALLOW
const ok = await app.inject({
  method: "POST", url: `/api/${p.tenantId}/it/devices`,
  headers: p.as("it_admin"), payload: { name: "Switch", kind: "network" },
});
expect(ok.statusCode).toBe(201);

// DENY — same one-liner, different persona, different assertion
const denied = await app.inject({
  method: "POST", url: `/api/${p.tenantId}/it/devices`,
  headers: p.as("viewer"), payload: { name: "Switch", kind: "network" },
});
expect(denied.statusCode).toBe(403);
```

`p.as(persona)` returns the `{ authorization, "x-user-id" }` header pair the existing
`app.inject()` suites already use. Requires `config.serviceToken` to be set before `buildApp()` —
every suite that calls `buildApp()` already does this (see `pm-adversarial-authz.test.ts`'s
`beforeAll`); if you're writing a brand-new suite, copy that `beforeAll` block.

`seedPersonaTenant()` seeds a **new** tenant every call — nothing to clean up, nothing to collide
with. Pass a subset of keys if you only need a couple of personas (faster, and the error you get
from `p.as(key)` on a persona you didn't ask for is loud and names the fix, not a silent 401):

```
Error: seedPersonaTenant: persona "team_lead" was not seeded for this tenant. Pass it in the
"which" list, or drop the argument to seed the full set.
```

`isDeniedStatus(code)` is a tiny helper (`code === 401 || code === 403`) for when you don't care
which of the two it is, just that it's a refusal.

**Full working example, both directions, against a real Cerbos decision:**
`src/testing/personas.test.ts` — run it with `npx vitest run src/testing/personas.test.ts`
(needs `DATABASE_URL_TEST` + `gaiada-test-cerbos` running, same as every other `.db.test.ts`/
adversarial-authz suite in this repo).

## Backend — clicking around by hand (IAM-06a)

```
npm run build
DATABASE_URL=postgresql://... npm run seed:personas
```

Prints every persona's email + user id. Log in with the dev-login flow
(`GET /dev/user-by-email?email=...`, or the UI's `/login` in non-DEMO_MODE) using
`persona.<key>@iam-personas.test` — e.g. `persona.hr_manager@iam-personas.test`. Idempotent: run
it again after a schema change and it adopts the existing rows rather than duplicating them
(verified — see the IAM-06 report for the before/after grant counts).

---

## Frontend — Playwright (IAM-06b)

`platform-ui/e2e/personas.ts` exports `loginAsPersona(page, key)`:

```ts
import { test, expect } from "@playwright/test";
import { loginAsPersona } from "./personas";

test("ALLOW — superadmin sees Settings", async ({ page }) => {
  await loginAsPersona(page, "superadmin");
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
});

test("DENY — member does not see Settings", async ({ page }) => {
  await loginAsPersona(page, "member");
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
});
```

Full runnable version: `platform-ui/e2e/iam-personas-fixture.spec.ts` (project `personas` in
`playwright.config.ts` — `npx playwright test --project=personas`).

### ⚠ DEMO_MODE coverage — read this before writing a demo-mode persona spec

`npm run e2e`'s default project runs against `DEMO_MODE=1` (no backend). **DEMO_MODE does NOT
cover all 14 personas** — `src/lib/demoIdentity.ts` only ever resolved 4 coarse identity tiers,
and this ticket deliberately left that file alone (it's shared UI-program surface, not IAM-06's to
rewrite). `loginAsPersona` is honest about the gap rather than papering over it:

| Persona | Works under DEMO_MODE? | Demo identity used |
|---|---|---|
| `superadmin` | ✅ | `demo-hansel` (`hansel@gaiada.com`) |
| `group_executive` | ✅ | same `demo-hansel` — it carries both roles |
| `member` | ✅ | `gede-ic` (`gede@gaiada.com`) — exact role match |
| `search_staff` | ✅ | `seo-staff` (`seo-staff@gaiada.com`) — exact role match |
| `client_contact` | ✅ | `demo-client` (any email containing `client`) — exact role match |
| `company_admin`, `manager`, `team_lead`, `viewer`, `hr_staff`, `hr_manager`, `it_admin`, `search_manager`, `agency_approver` | ❌ | **none — throws** |

Calling `loginAsPersona(page, "team_lead")` under DEMO_MODE throws immediately, before touching
the page:

```
DEMO_MODE has no identity for persona "team_lead". src/lib/demoIdentity.ts only resolves 4 coarse
tiers today ... Run this spec against a real backend instead...
```

This is deliberate: silently substituting `demo-hansel` (superadmin) for an unsupported persona
would make a DENY assertion pass for the wrong reason — exactly the failure class this whole
program exists to catch, not reintroduce. If your spec needs one of the 9 unsupported personas,
run it against a real backend:

```
# platform-nest: seed once
DATABASE_URL=... npm run seed:personas
# platform-ui: point at that backend, skip DEMO_MODE
PLATFORM_URL=http://localhost:3004 npx playwright test --project=personas
```
and call `loginAsPersona(page, key, { demoMode: false })`.

---

## What you still have to figure out yourself

- **Team scoping beyond the default team.** `seedPersonaTenant()`'s `team_lead` is always the lead
  of ONE auto-created team. If your test needs two teams (e.g. "lead of team A denied on team B's
  resource"), seed the second team yourself with a direct insert — this helper doesn't generalize
  to multi-team scenarios.
- **Module-gating surprises.** Both seed paths enable a broad module set (`agency, hr, reports,
  search, assistant, webdev, pm, it`) on the persona tenant so a persona's role actually reaches
  something. If you add a NEW module-gated surface, its module key needs adding to both
  `src/seed/personas.ts` and `src/testing/personas.ts` or the persona will look "denied" for a
  reason that has nothing to do with the permission you're testing (fail-closed module gate, not
  a role gate — check the response body, a 404 here means "module not enabled", not "not
  authorized").
- **The `owner` role does not exist.** Do not write a test that assumes one; there's no persona for
  it and none will appear until Phase 3 (IAM-14).
- **Cerbos staleness.** If a persona test gives a surprising DENY/ALLOW that doesn't match the
  policy file on disk, check `docker inspect gaiada-test-cerbos --format '{{.State.StartedAt}}'`
  against the policy file's last edit time before assuming the fixture is wrong — a long-running
  container can serve days-old policy on Windows (bind-mount inotify doesn't propagate).
