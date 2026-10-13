import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listCourses, listPaths, formatDuration, LEVELS, LEVEL_LABEL, type Level } from "@/lib/lms";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ModuleDisabled } from "@/components/ModuleDisabled";
import { isModuleOnForActiveCompany } from "@/lib/modules";
import { getOrgStructure } from "@/lib/org";
import { unitSubtree, inUnit } from "@/lib/learningScope";

// Learning › Catalogue — everything on offer, for everyone.
//
// Deliberately open to every member: a course is the company's own material, and training you
// cannot see is a support ticket rather than a security posture (resource_lms_course.yaml's read
// rule names `member` for exactly this reason). What is NOT open is anyone's progress or scores —
// those live on /learning/compliance behind `lms.progress.view`.
//
// `?unit=<org node id>` (DW-4f, the Learning row's "Department courses" tab) narrows the page to that
// department's SUBTREE: a department's courses may sit on its divisions, and the backend's
// `unitNodeId=` filter matches one exact node, so the page filters instead. Nothing new is revealed —
// the unfiltered catalogue is open to every member.
export default async function LearningCataloguePage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string; discipline?: string; track?: string; unit?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  // The `lms` module answers 403/404 on every route while it is dark, and `soft()` turns that into
  // an empty list — which renders as "nothing is published" rather than "this is switched off".
  // Ask the gate first so the two never look alike.
  if (!(await isModuleOnForActiveCompany("lms"))) return <ModuleDisabled module="lms" label="Learning" />;

  const sp = await searchParams;
  const level = LEVELS.includes(sp.level as Level) ? (sp.level as Level) : undefined;
  const track = sp.track === "general" || sp.track === "department" ? sp.track : undefined;

  // The department view: resolve the subtree first, so an unknown id never renders a list.
  let scope: { name: string; ids: Set<string> } | null = null;
  if (sp.unit) {
    const company = me.companies.find((c) => c.id === tenant) ?? { id: tenant, name: tenant, type: null };
    const { structure } = await getOrgStructure(userId, tenant, company);
    scope = unitSubtree(structure, sp.unit);
    if (!scope) {
      return (
        <EmptyNote>
          This department does not exist.{" "}
          <Link href="/learning/catalogue" style={{ color: "var(--erp-accent)" }}>Whole catalogue</Link>
        </EmptyNote>
      );
    }
  }
  const unitQs = sp.unit ? `unit=${encodeURIComponent(sp.unit)}` : "";
  const catalogueHref = (extra = "") => {
    const qs = [unitQs, extra].filter(Boolean).join("&");
    return qs ? `/learning/catalogue?${qs}` : "/learning/catalogue";
  };

  const [allCourses, allPaths] = await Promise.all([
    listCourses(userId, tenant, { level, discipline: sp.discipline, track: scope ? "department" : track }),
    listPaths(userId, tenant),
  ]);
  const courses = scope ? inUnit(allCourses, scope.ids) : allCourses;
  const paths = scope ? inUnit(allPaths.filter((p) => p.track === "department"), scope.ids) : allPaths;

  const mandatory = paths.filter((p) => p.isMandatory);
  const disciplines = [...new Set(courses.map((c) => c.discipline).filter((d): d is string => !!d))].sort();
  const byLevel = LEVELS.map((l) => ({ level: l, n: courses.filter((c) => c.level === l).length }));

  return (
    <>
      {scope && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
          <span className="type-eyebrow">Department courses · {scope.name}</span>
          <Link href="/learning/catalogue" className="lux-btn lux-btn--sm lux-btn--ghost">Whole catalogue</Link>
        </div>
      )}
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Courses" value={String(courses.length)} foot={scope ? `for ${scope.name}` : "published"} />
        <KpiTile label="Paths" value={String(paths.length)} foot={scope ? `for ${scope.name}` : undefined} />
        {scope ? (
          <KpiTile label="Required of everyone" value="—" foot="company-wide courses: whole catalogue" />
        ) : (
          <KpiTile label="Required of everyone" value={String(mandatory.length)} foot="the general track" />
        )}
        <KpiTile label="Disciplines" value={String(disciplines.length)} foot={disciplines.slice(0, 3).join(", ") || undefined} />
      </div>

      {/* Level is the axis that makes this "all levels" — the same discipline carries a
          management-tier path alongside the hands-on ones. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18, alignItems: "center" }}>
        <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>Level:</span>
        <Link
          href={catalogueHref()}
          className={`lux-btn lux-btn--sm ${!level ? "lux-btn--solid" : "lux-btn--ghost"}`}
        >
          All
        </Link>
        {byLevel.map((b) => (
          <Link
            key={b.level}
            href={catalogueHref(`level=${b.level}`)}
            className={`lux-btn lux-btn--sm ${level === b.level ? "lux-btn--solid" : "lux-btn--ghost"}`}
          >
            {LEVEL_LABEL[b.level]} ({b.n})
          </Link>
        ))}
      </div>

      <Card
        title="Learning paths"
        hint="A path is an ORDERED sequence — the steps are meant to be taken in order, and completing one earns a certificate."
        style={{ marginBottom: 22 }}
      >
        {paths.length === 0 && scope ? (
          <EmptyNote>No path for {scope.name} yet.</EmptyNote>
        ) : paths.length === 0 ? (
          <EmptyNote>
            No paths published yet. A path is what gets assigned and what certifies — individual
            courses are its building blocks.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Path" }, { label: "Track" }, { label: "Level" },
              { label: "Courses", align: "right" }, { label: "Certificate" },
            ]}
            rows={paths.map((p) => [
              <span key={p.id}>
                <Link href={`/learning/paths/${p.id}`} style={{ color: "var(--erp-accent)" }}>{p.title}</Link>
                {p.isMandatory && (
                  <span className="type-eyebrow" style={{ marginLeft: 8, fontSize: 10 }}>
                    required
                  </span>
                )}
              </span>,
              p.track === "general" ? "Everyone" : (p.unitNodeId ?? "department"),
              LEVEL_LABEL[p.level],
              String(p.courseCount),
              p.certificationValidMonths
                ? `valid ${p.certificationValidMonths} months`
                : p.certificationLabel
                  ? "does not expire"
                  : "—",
            ])}
          />
        )}
      </Card>

      <Card title={level ? `Courses — ${LEVEL_LABEL[level]}` : scope ? `Courses — ${scope.name}` : "All courses"}>
        {courses.length === 0 ? (
          <EmptyNote>
            {scope
              ? <>No course for {scope.name} yet.{" "}<Link href="/learning/catalogue" style={{ color: "var(--erp-accent)" }}>Whole catalogue</Link></>
              : level
              ? `Nothing published at ${LEVEL_LABEL[level]} level yet.`
              : "No published courses. A course must be published before it can be added to a path or assigned — a draft is invisible here by design."}
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Course" }, { label: "Track" }, { label: "Discipline" },
              { label: "Level" }, { label: "Time", align: "right" },
            ]}
            rows={courses.map((c) => [
              <Link key={c.id} href={`/learning/courses/${c.id}`} style={{ color: "var(--erp-accent)" }}>
                {c.title}
              </Link>,
              c.track === "general" ? "Everyone" : (c.unitNodeId ?? "—"),
              c.discipline ?? "—",
              LEVEL_LABEL[c.level],
              formatDuration(c.estimatedMinutes),
            ])}
          />
        )}
      </Card>
    </>
  );
}
