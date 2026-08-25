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

// Learning › Catalogue — everything on offer, for everyone.
//
// Deliberately open to every member: a course is the company's own material, and training you
// cannot see is a support ticket rather than a security posture (resource_lms_course.yaml's read
// rule names `member` for exactly this reason). What is NOT open is anyone's progress or scores —
// those live on /learning/compliance behind `lms.progress.view`.
export default async function LearningCataloguePage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string; discipline?: string; track?: string }>;
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

  const [courses, paths] = await Promise.all([
    listCourses(userId, tenant, { level, discipline: sp.discipline, track }),
    listPaths(userId, tenant),
  ]);

  const mandatory = paths.filter((p) => p.isMandatory);
  const disciplines = [...new Set(courses.map((c) => c.discipline).filter((d): d is string => !!d))].sort();
  const byLevel = LEVELS.map((l) => ({ level: l, n: courses.filter((c) => c.level === l).length }));

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Courses" value={String(courses.length)} foot="published" />
        <KpiTile label="Paths" value={String(paths.length)} />
        <KpiTile label="Required of everyone" value={String(mandatory.length)} foot="the general track" />
        <KpiTile label="Disciplines" value={String(disciplines.length)} foot={disciplines.slice(0, 3).join(", ") || undefined} />
      </div>

      {/* Level is the axis that makes this "all levels" — the same discipline carries a
          management-tier path alongside the hands-on ones. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18, alignItems: "center" }}>
        <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>Level:</span>
        <Link
          href="/learning/catalogue"
          className={`lux-btn lux-btn--sm ${!level ? "lux-btn--solid" : "lux-btn--ghost"}`}
        >
          All
        </Link>
        {byLevel.map((b) => (
          <Link
            key={b.level}
            href={`/learning/catalogue?level=${b.level}`}
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
        {paths.length === 0 ? (
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

      <Card title={level ? `Courses — ${LEVEL_LABEL[level]}` : "All courses"}>
        {courses.length === 0 ? (
          <EmptyNote>
            {level
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
