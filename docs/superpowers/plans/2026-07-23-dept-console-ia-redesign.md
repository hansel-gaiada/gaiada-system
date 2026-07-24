# Department Console — IA Redesign & Template Generalization

**Date:** 2026-07-23
**Status:** Phase A DONE (2026-07-23) — template + Web Dev + Creatives migrated,
verified end-to-end (tsc clean, 248 unit tests green, live browser drive confirms
both consoles). Phase B (SEO + SMM) not started.
**Scope:** Redesign the department-console navigation from a single flat tab strip to a
two-level grouped IA; migrate Web Dev + Creatives onto it; make the toolkit a clean,
extensible template ready for SEO and SMM (designed now, built next).

---

## 1. Problem

The department console (`/departments/[deptId]`) renders **one flat `SectionTabs`
strip** whose tabs come from a per-department toolkit (`lib/deptToolkits.ts`).

- **Web Dev** has **9 flat tabs**: Home · Projects · Board · Timeline · Activity ·
  PRD Studio · Repositories · Deliverables · Connections. Too many peers in one row —
  no hierarchy, no grouping, "doesn't flow." Unrelated things (a schedule view and an
  integrations settings page) sit as equal siblings.
- **Creatives** has 3 (Home · Image Studio · Build Tools), one of which (Build Tools)
  is a dead redirect to Home. Creatives has **no access to the Work views** (Board,
  Timeline, Activity) even though those pages already render for any department.
- Adding SEO/SMM tools would pile more flat tabs on, making the strip worse.

Root cause: the toolkit models a **flat list of tabs** when the real IA is **two levels**
— a small stable spine of *groups*, each holding related *tools*.

## 2. Target IA (two-level)

**Primary strip = groups. Secondary strip = the active group's sub-tabs.**
A group with a single tab (Home, Connections) navigates directly and shows no secondary
strip. The routes/paths do **not** change — only how tabs are grouped and rendered — so
existing page files stay where they are.

```
Web Dev
 ● Home    ○ Work    ○ Build    ○ Connections          ← primary (groups)
             └ Projects · Board · Timeline · Activity   ← secondary (sub-tabs, shown when Work active)
```

### Universal spine (every department inherits)

| Group        | Sub-tabs                                   | Notes |
|--------------|--------------------------------------------|-------|
| **Home**     | *(none — direct)*                          | Command center. Unchanged content. |
| **Work**     | Projects · Board · Timeline · Activity     | The execution views. Generic `[deptId]` pages — already work for any dept. |
| **Connections** | *(none — direct)*                       | Integrations/settings. Made universal (was Web-Dev-only). |

### Department-specific "craft" group (the differentiator)

| Dept       | Craft group label | Sub-tabs                                   | Status |
|------------|-------------------|--------------------------------------------|--------|
| **Web Dev**| **Build**         | PRD Studio · Repositories · Deliverables   | migrate now |
| **Creatives** | **Studio**     | Image Studio · Asset Library               | migrate now (split today's single studio page into two sub-tabs) |
| **SEO**    | **Optimize**      | Site Audit · Keywords · Rankings · Content Briefs | design now, build next |
| **SMM**    | **Publish**       | Calendar · Composer · Inbox · Analytics    | design now, build next |

Result: Web Dev goes from **9 flat tabs → 4 groups**; Creatives gains the Work spine +
Connections and a cleaner Studio; every future dept follows the same shape.

## 3. Data model change (`lib/deptToolkits.ts`)

Introduce a group layer; keep `DeptTab` as-is (path/icon/blurb unchanged).

```ts
export interface DeptTab { key; label; path; icon; blurb }      // unchanged

export interface DeptGroup {
  key: string;
  label: string;
  icon: IconName;
  tabs: DeptTab[];        // 1+ ; a single-tab group renders as a direct link (no sub-strip)
}

export interface DeptToolkit {
  slug; label; mission;
  groups: DeptGroup[];    // was: tabs: DeptTab[]
  launchers: DeptLauncher[];
}
```

Helpers:
- `toolkitFor(name)` — unchanged contract; generic fallback = single **Home** group.
- New `activeGroup(toolkit, pathname, deptId)` → resolves which group owns the current
  path (longest-prefix match across all sub-tabs), for rendering the secondary strip.
- `tabHref` unchanged.
- `hasBespokeToolkit` unchanged.

Backwards note: any code reading `toolkit.tabs` (sidebar `nav.ts` does **not**; it only
reads `toolkitFor().mission`/label — verify during impl) gets updated to flatten groups.

## 4. Rendering change

### `SectionTabs` — reuse, don't fork
Keep `SectionTabs` as the generic strip (still used by IT/HR/Settings). Add a thin
**`GroupTabs`** wrapper (or a `variant="primary|secondary"` prop) in
`components/shell/` so the two strips read as a hierarchy, not two identical rows:
- **Primary**: group labels + icons; active = the group owning the current path.
- **Secondary**: the active group's sub-tabs; only rendered when the group has >1 tab.
  Visually lighter (smaller, indented/underlined) so it clearly reads as a sub-level.

### `[deptId]/layout.tsx`
Replace the single `<SectionTabs tabs=… />` with:
```tsx
const grp = activeGroup(toolkit, pathname, deptId);
<GroupTabs groups={…} active={grp} />                 // primary
{grp && grp.tabs.length > 1 && <SubTabs tabs={grp.tabs} />}   // secondary
```
`layout.tsx` is a server component; the active-path logic lives in the client strip
components (as `SectionTabs` already does via `usePathname`). No data-fetching changes;
the My-Work rail and header are untouched.

## 5. Content/flow polish (the "comfortable to use" part)

Beyond grouping, address the comfort complaint:
1. **Creatives Studio split** — today `studio/page.tsx` stacks `<ImageStudio>` +
   `<AssetLibrary>` in one scroll. Split into **Image Studio** and **Asset Library**
   sub-tabs so each has room; Studio is the default sub-tab.
2. **Kill the dead "Build Tools" tab** in Creatives (already a redirect to Home; build
   tools live in Home's launcher row).
3. **Connections everywhere** — every dept gets the Connections group so integrations
   have a consistent home.
4. **Secondary-strip visual treatment** — follow the design system; the sub-tab strip
   must be visibly subordinate (weight/size/spacing), with the active group highlighted
   in the primary strip so the two levels feel connected, not stacked.
5. Preserve the persistent **My Work rail** and `PageHeader` exactly as-is.

## 6. Work breakdown

**Phase A — Template & migration (this effort)**
1. `deptToolkits.ts`: add `DeptGroup`, convert `WEB_DEV` + `CREATIVES` to groups, add
   `activeGroup()`, update generic fallback. Update any `toolkit.tabs` readers.
2. `components/shell/`: add `GroupTabs` (primary) + secondary sub-tab rendering; CSS for
   the two-level hierarchy (`sec-tabs` + new subordinate style).
3. `[deptId]/layout.tsx`: render primary + conditional secondary strip.
4. Creatives: split `studio/page.tsx` → `studio` (Image Studio) + `assets` (Asset
   Library) routes; give Creatives the Work + Connections groups; remove `tools` tab
   (keep redirect route for old bookmarks).
5. Verify Web Dev + Creatives end-to-end; `tsc` clean; update/extend unit tests for the
   toolkit + active-group resolution; run Playwright e2e.

**Phase B — SEO + SMM (next effort, after A ships)**
6. Add `SEO` toolkit (**Optimize**: Site Audit · Keywords · Rankings · Content Briefs)
   + its pages. (Semrush MCP connector is available once authorized — natural data source.)
7. Add `SMM` toolkit (**Publish**: Calendar · Composer · Inbox · Analytics) + its pages.
8. Each reuses Home/Work/Connections spine unchanged — only the craft group is new.

## 7. Non-goals / preserved

- No routing/URL scheme change; existing deep links keep working.
- No backend/BFF contract changes for Phase A.
- `SectionTabs` stays the shared component for non-department consoles (IT/HR/Settings).
- My Work rail, PageHeader, RBAC gating, launcher rows — unchanged.

## 8. Open questions (non-blocking; sensible defaults chosen)

- **Deliverables placement** — placed under Web Dev's **Build** group (it's the output
  of the build pipeline). If it should be universal (every dept produces deliverables),
  promote it to the Work group later — cheap to move.
- **Creatives Work spine** — assumed yes (pages already exist and render per-dept). If
  Creatives should stay tool-only, drop the Work group from its toolkit.
