import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can, canInUnit, leadUnits, leadsAnyUnitWith, unitPathOf } from "@/lib/rbac";
import { listCourses, listPaths, formatDuration, LEVEL_LABEL } from "@/lib/lms";
import { createCourse } from "@/lib/lmsActions";
import { listDepartments } from "@/lib/departments";
import { readOrgRoot } from "@/lib/campaigns-data";
import type { OrgNode } from "@/lib/org";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ModuleDisabled } from "@/components/ModuleDisabled";
import { isModuleOnForActiveCompany } from "@/lib/modules";
import { CourseForm } from "@/components/lms/CourseForm";

// Learning › Authoring — the surface the owner asked for: "we seed trainings for each departments
// and later each HOD should make more."
//
// Every course is listed, including OTHER departments' — deliberately. A head who cannot see what
// Creative already teaches will write it again, and the catalogue is open to `member` anyway, so
// hiding it here would buy nothing and cost the one thing this page is for. What differs is the
// controls: publish and retire appear only where the caller could plausibly use them, and the
// server refuses regardless.
//
// DW-4g (BFF §38): a department head holds `lms.authoring` / `lms.publish` only at their unit, which the
// company-wide `can()` never counts. So the page opens for a company-wide holder as before, and for a head
// through `canInUnit` on the unit in `?unit=` (their department's "Add material" tab), or, with no `unit`,
// on any unit they lead. A head is offered department-track courses only, for the units they lead (the
// subtree below a led unit included). This only decides what the page OFFERS; Cerbos' `unitAncestors`
// containment on the server is the authority and refuses anything else.
function findNode(root: OrgNode, id: string): OrgNode | null {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const n = findNode(c, id);
    if (n) return n;
  }
  return null;
}

/** A led unit and every department/division beneath it, as select options. */
function ledUnitOptions(root: OrgNode, led: readonly string[]): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const add = (n: OrgNode) => {
    if ((n.kind === "department" || n.kind === "division") && !out.some((o) => o.value === n.id)) {
      out.push({ value: n.id, label: n.name });
    }
    for (const c of n.children ?? []) add(c);
  };
  for (const id of led) {
    const node = findNode(root, id);
    if (node) add(node);
  }
  return out;
}

export default async function AuthoringPage({
  searchParams,
}: {
  searchParams: Promise<{ unit?: string | string[] }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  if (!(await isModuleOnForActiveCompany("lms"))) return <ModuleDisabled module="lms" label="Learning" />;

  const sp = await searchParams;
  const unit = typeof sp.unit === "string" && sp.unit !== "" ? sp.unit : null;

  // Company-wide holders keep exactly today's behaviour. The org tree is read only when it can change the
  // answer: a `?unit=` to check, or a head (no company-wide right) whose led units must be found.
  const wideAuthor = can(me, "lms.authoring", tenant);
  const widePublish = can(me, "lms.publish", tenant);
  const maybeHead = leadUnits(me).length > 0;
  const root = unit !== null || (!wideAuthor && maybeHead) ? await readOrgRoot(me, tenant) : null;
  const unitPath = unit !== null && root ? unitPathOf(root, unit) : [];

  let mayAuthor: boolean;
  let mayPublish: boolean;
  if (unit !== null) {
    mayAuthor = canInUnit(me, "lms.authoring", tenant, unitPath);
    mayPublish = canInUnit(me, "lms.publish", tenant, unitPath);
  } else {
    // Without a unit a head needs to lead at least one unit that exists in this company's tree (a grant
    // for a node of another company is not a lead here).
    const ledHere = root ? leadUnits(me).filter((u) => unitPathOf(root, u).length > 0) : [];
    mayAuthor = wideAuthor || (leadsAnyUnitWith(me, "lms.authoring", tenant) && ledHere.length > 0);
    mayPublish = widePublish || (leadsAnyUnitWith(me, "lms.publish", tenant) && ledHere.length > 0);
  }

  // Fail closed with a sentence rather than an empty authoring console. A head who lost the lead
  // position should be told, not left looking at a page whose buttons all 403.
  if (!mayAuthor) {
    return (
      <EmptyNote>
        Authoring training is for department heads, HR and company administrators. You can browse
        everything on offer in the <Link href="/learning/catalogue" style={{ color: "var(--erp-accent)" }}>catalogue</Link>.
      </EmptyNote>
    );
  }
  const canPublish = mayPublish;
  // A head, not a company-wide author: department track only, and only the units they lead.
  const departmentOnly = !wideAuthor;

  // `status` is deliberately omitted so DRAFTS come back too — the catalogue hides them by design,
  // and an authoring console that could not see its own unpublished work would be useless.
  const [courses, paths, departments] = await Promise.all([
    listCourses(userId, tenant),
    listPaths(userId, tenant),
    listDepartments(userId, tenant).catch(() => []),
  ]);

  const drafts = courses.filter((c) => c.status === "draft" || c.status === "in_review");
  const published = courses.filter((c) => c.status === "published");
  const retired = courses.filter((c) => c.status === "retired");
  const unitOptions = departmentOnly && root
    ? ledUnitOptions(root, leadUnits(me))
    : departments.map((d) => ({ value: d.id, label: d.name }));

  const courseRows = (list: typeof courses) =>
    list.map((c) => [
      <Link key={c.id} href={`/learning/authoring/${c.id}`} style={{ color: "var(--erp-accent)" }}>
        {c.title}
      </Link>,
      <span key={`${c.id}-k`} style={{ font: "400 12px var(--font-mono, monospace)", color: "var(--erp-ink-60)" }}>
        {c.courseKey} · v{c.version}
      </span>,
      c.track === "general" ? "Everyone" : (c.unitNodeId ?? "—"),
      c.discipline ?? "—",
      LEVEL_LABEL[c.level],
      formatDuration(c.estimatedMinutes),
      <StatusBadge key={`${c.id}-s`} label={c.status} />,
    ]);

  const COLUMNS = [
    { label: "Course" }, { label: "Key" }, { label: "Owner" },
    { label: "Discipline" }, { label: "Level" }, { label: "Time" }, { label: "Status" },
  ];

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Drafts" value={String(drafts.length)} foot="not visible to learners" />
        <KpiTile label="Published" value={String(published.length)} foot="assignable" />
        <KpiTile label="Paths" value={String(paths.length)} />
        <KpiTile
          label="Retired" value={String(retired.length)}
          hint="A retired course keeps existing enrolments working and accepts no new ones. Nothing is deleted — a course with completions against it must stay readable."
        />
      </div>

      <div style={{ marginBottom: 20 }}>
        <CourseForm
          create={createCourse} unitOptions={unitOptions}
          departmentOnly={departmentOnly} defaultUnit={unit ?? undefined}
        />
      </div>

      {!canPublish && (
        // Said once, up front. The alternative is an author writing a whole course and discovering
        // at the last step that they cannot ship it.
        <Card title="You can write, but not publish" style={{ marginBottom: 20 }}>
          <p style={{ margin: 0, font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
            Drafts are yours to build. Publishing freezes what people will be certified against, so
            it belongs to a department head or a company administrator — ask one to review and
            publish when the course is ready.
          </p>
        </Card>
      )}

      <Card
        title="Drafts"
        hint="A draft is invisible to learners and cannot be added to a path. That is what makes it safe to work in."
        style={{ marginBottom: 22 }}
      >
        {drafts.length === 0 ? (
          <EmptyNote>
            No drafts. Editing a PUBLISHED course creates one automatically — the published version
            stays exactly as it is until you publish the new one.
          </EmptyNote>
        ) : (
          <HairlineTable columns={COLUMNS} rows={courseRows(drafts)} />
        )}
      </Card>

      <Card title="Published" style={{ marginBottom: 22 }}>
        {published.length === 0 ? (
          <EmptyNote>Nothing published in this company yet.</EmptyNote>
        ) : (
          <HairlineTable columns={COLUMNS} rows={courseRows(published)} />
        )}
      </Card>

      {retired.length > 0 && (
        <Card title="Retired" hint="Withdrawn from assignment. Existing enrolments still work." style={{ marginBottom: 22 }}>
          <HairlineTable columns={COLUMNS} rows={courseRows(retired)} />
        </Card>
      )}

      <Card
        title="Learning paths"
        hint="A path is the ORDERED sequence that gets assigned and certifies. Individual courses are its building blocks."
      >
        {paths.length === 0 ? (
          <EmptyNote>
            No paths yet. A course on its own is never assigned — build a path from one or more
            published courses, then publish the path.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Path" }, { label: "Key" }, { label: "Level" }, { label: "Courses", align: "right" }, { label: "Status" }]}
            rows={paths.map((p) => [
              <span key={p.id}>
                {p.title}
                {p.isMandatory && (
                  <span className="type-eyebrow" style={{ marginLeft: 8, fontSize: 10 }}>required</span>
                )}
              </span>,
              <span key={`${p.id}-k`} style={{ font: "400 12px var(--font-mono, monospace)", color: "var(--erp-ink-60)" }}>
                {p.pathKey}
              </span>,
              LEVEL_LABEL[p.level],
              String(p.courseCount),
              <StatusBadge key={`${p.id}-s`} label={p.status} />,
            ])}
          />
        )}
      </Card>
    </>
  );
}
