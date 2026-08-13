# Sidebar nav map — where every item lives

**Status:** living document. **Owner of truth:** [`platform-ui/src/components/shell/nav.ts`](../platform-ui/src/components/shell/nav.ts).
This file is the *human* index of that function plus a per-push record of what moved.

The sidebar changes on nearly every UI push and the diffs are hard to read (one array literal,
capability-gated rows appearing and disappearing). **Update the tables below in the same commit that
changes `nav.ts`** — a nav move with no entry here is treated as an accident, not a decision.

---

## 1. How the sidebar renders

Two modes, one nav model. `navFor(me, tenantId, departments)` returns `NavGroup[]`; the renderer
decides how each group is drawn.

| Field | Meaning |
|---|---|
| `label` | Group heading. **Empty string** = unlabelled single row (Settings) — never collapsible. |
| `items` | The rows. Each has its own `icon` (shown in expanded mode and in flat rail rows). |
| `icon` | The group's **rail glyph** — only used when the group becomes a collapsed-mode flyout category. Falls back to `box`. |
| `pinned` | Expanded: open by default, always. Rail: rows render **flat** (no flyout). |

**Expanded (248px)** — every group is a collapsible disclosure (`NavGroupSection`). Multi-open on
purpose; the group holding the current route opens by default; an explicit click wins over that.

**Collapsed rail (64px)** — per group:

1. `pinned: true` → items render as flat icon rows.
2. `items.length === 1` → flat icon row (a flyout for one row costs more than it saves).
3. otherwise → one `group.icon` glyph opening a flyout (`RailCategory`) on click/hover/`ArrowDown`.

Below the drawer breakpoint the off-canvas panel wins and the collapse button hides — touch has no
hover, so the rail is width-gated, not pointer-gated. State persists in the **`gaiada_sidebar`**
cookie (separate from the `gaiada_prefs` blob) and is stamped on `<html data-sidebar>` server-side so
a collapsed rail never flashes open.

---

## 2. Current nav (as of 2026-08-07, the `fadhil/ui` merge)

Order top → bottom. "Rail" is what the collapsed 64px mode shows.

| # | Group | Rail | Glyph | Rows (in order) | Gate |
|---|---|---|---|---|---|
| 1 | **Me** | flyout | `user` | Overview `/me` · Inbox `/me/inbox` · Leave `/me/leave` · Loans `/me/loans` | none — every staff principal |
| 2 | **Workspace** | **flat (pinned)** | — | Dashboard `/` · Calendar `/calendar` · Approvals `/approvals` | none |
| 3 | **Organization** | flat (1 row) | `sitemap` (unused while 1 row) | Overview `/organization` | none |
| 4 | **Departments** | flyout | `hr` | one row per department `/departments/:id` · HR `/hr` · IT `/it` | none (rows come from the active company's org structure) |
| 5 | **Business** | flyout | `briefcase` | Projects · Tasks · Clients · Deliverables · Timesheets · **Billing** · Agency · Meetings · Delivery Pipeline · **Monitoring** (+ `/monitoring/new`, `/monitoring/channels`) · **Rollups** | Billing → `company.manage`; Rollups → `rollups.view`; Monitoring → none (backend `monitoring.read` is the boundary) |
| 6 | **Reports** | flyout | `chart` | My Report `/reports/person` · Project `/reports/project` · Department `/reports/department` · **Company** `/reports/company` | Company → `rollups.view` |
| 7 | **Appraisals** | flyout | `award` | My Appraisals `/appraisals/mine` · **Team** `/appraisals` · **Cycles** `/appraisals/cycles` | Team → `appraisal.score`\|`appraisal.read`; Cycles → `appraisal.cycle.admin` |
| 8 | **Intelligence** | flyout | `agents` | Assistant `/assistant` · Knowledge `/knowledge` · AI Agents `/agents` | none (Assistant threads are owner-private in the backend) |
| 9 | **Systems** | flyout | `server` | WA/TG Bot · AI Gateway · MCP Hub · Automation | none |
| 10 | *(unlabelled)* | flat | — | Settings `/admin` | `admin.access` |

**Client-only principals** (`isClientOnly`) get a *different* nav entirely: a single **Portal → Your
portal** `/portal` row. The portal has its own route group and shell; that row is the escape hatch
for a client who lands on an `(app)` route from a stale bookmark.

Rail glyph budget for an elevated user: 3 flat (Workspace) + 1 (Organization) + 6 flyout categories
+ 1 (Me) + 1 (Settings) ≈ **12 icons** standing in for ~35 rows.

---

## 3. Change log — one entry per push that touches `nav.ts`

### 2026-08-13 — MON: **Monitoring** added to Business

Plane B (client property/service monitoring) gets one row: **Monitoring** `/monitoring`, icon
`pulse`. Sub-surfaces `/monitoring/new` and `/monitoring/channels` are reached from the page, not
the sidebar — three rows for one capability would crowd a group that already has ten.

**Why Business and not Systems.** Systems holds *our* infrastructure consoles (Bot, Gateway, Hub,
Automation). Monitoring's subject is the **client's** websites and services — it is client work, and
it is the surface we intend to sell. Putting it in Systems would file it as internal plumbing and
quietly re-merge the two planes the design keeps apart (`docs/blueprints/monitoring-program.md` §0).
Platform observability (Prometheus/Grafana/Loki/Tempo) stays out of the ERP entirely, behind an SSH
tunnel, and is deliberately **not** a nav row.

**Ungated on purpose.** No capability in the Gate column: `monitoring.read` on platform-nest is the
boundary, and `nav.test.ts` pins the row for a plain `member` so a future gate cannot be added here
by accident. A UI-only gate would hide a page the server would serve — which users read as broken,
not forbidden.

**Glyph:** reuses `pulse` (shared with Delivery Pipeline and Rollups). No new icon: `pulse` is the
right shape for a health/liveness surface, and the rail only draws a group glyph, so the collision
is invisible there.

### 2026-08-07 — merge `fadhil/ui` → `main` (collapsible sidebar + 64px icon rail)

Branch was **1 commit ahead / 163 behind**; it forked before `Me` and `Assistant` existed. One
conflict (`nav.ts`), resolved by keeping **both** sides:

| What | Where it came from | Resolution |
|---|---|---|
| `Me` group (position 1) | `main` | Kept first, ungated. Given `icon: "user"` so it has a rail glyph. |
| `Assistant` row in Intelligence | `main` | Kept as the group's first row. |
| `pinned: true` on Workspace | `fadhil/ui` | Kept. |
| `icon` on Organization/Departments/Business/Reports/Appraisals/Intelligence/Systems | `fadhil/ui` | Kept. |
| `NavGroup.icon` + `NavGroup.pinned` fields | `fadhil/ui` | Kept. |

**Decision — `Me` is a flyout, not pinned.** Pinning both `Me` (4 rows) and `Workspace` (3 rows)
would put 7 flat rows above the category glyphs and undo the rail's point. Flip `pinned: true` on
`Me` in `nav.ts` if personal rows should out-rank that; nothing else needs to change.

**New icon:** `user` (one person) added to `icons.tsx` — `hr` is the group-of-people glyph and was
already the Departments category, so reusing it would have put the same shape twice in the rail.

Also landed in the same merge (not `nav.ts`, but sidebar behaviour):
`sidebarState.tsx` (client context — the rail is a different *renderer*, not narrower CSS),
`SidebarToggle.tsx`, `RailCategory.tsx`, `NavGroupSection.tsx`, `railTooltip.tsx`,
the `gaiada_sidebar` cookie in `lib/prefs.ts`, and `shell.css` rail rules.

**Known cosmetic gap:** Organization has one row, so the rail draws that row's `inventory` glyph and
the group's `sitemap` glyph is never used. Harmless today; it becomes the right glyph the moment a
second row lands under Organization.

### Earlier (pre-dating this file)

Not reconstructed. `git log -- platform-ui/src/components/shell/nav.ts` is the fallback.

---

## 4. Rules for the next nav change

1. **Add the row to `nav.ts` and the table in §2 in the same commit.** Add a §3 entry saying *why* it
   sits where it sits.
2. **A new group needs an `icon`** or the rail draws a generic `box`. Check §2 for a glyph already in
   use before picking one.
3. **A group that will only ever hold one row** doesn't need an `icon` — the rail flattens it.
4. **Capability-gated rows belong in the Gate column**, with the exact capability string. A row with
   no gate here is asserting *every staff principal sees it*.
5. `nav.test.ts` asserts group/row composition — extend it, don't loosen it.
6. The rail e2e specs (`e2e/app.spec.ts`) are **not** `@smoke`-tagged, so CI does not run them. They
   need the backend; run them by hand against a live stack when the sidebar changes.
