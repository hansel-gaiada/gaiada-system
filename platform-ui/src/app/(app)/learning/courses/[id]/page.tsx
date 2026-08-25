import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getCourse, formatDuration, LEVEL_LABEL, type Activity } from "@/lib/lms";
import { Card, KpiTile, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ModuleDisabled } from "@/components/ModuleDisabled";
import { isModuleOnForActiveCompany } from "@/lib/modules";

// Learning › a single course — its modules and, inside each, its ordered activities.
//
// ⚠ DOES NOT DEGRADE. `getCourse` rethrows on 403/404 rather than returning an empty course,
//   because "this course has no content" and "you may not read this course" render identically,
//   and a learner told a mandatory course is empty stops looking. The module gate above catches
//   the one 404 that IS explainable — the LMS being switched off — so what reaches the error
//   boundary is a genuine failure.

/** What a learner is being asked to DO, in the words of the thing rather than the enum. */
const KIND_LABEL: Record<Activity["kind"], string> = {
  read: "Reading",
  watch: "Video",
  quiz: "Quiz",
  scenario: "Scenario",
  lab: "Hands-on lab",
};

/** Who decides whether it passed. Stated per activity because the LMS grades by discipline. */
const GRADING_NOTE: Record<Activity["grading"], string> = {
  auto: "graded automatically",
  review: "reviewed by a person",
  none: "not graded — completion only",
};

export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  if (!(await isModuleOnForActiveCompany("lms"))) return <ModuleDisabled module="lms" label="Learning" />;

  const { id } = await params;
  const course = await getCourse(userId, tenant, id);

  const activities = course.modules.flatMap((m) => m.activities);
  const required = activities.filter((a) => a.isRequired);
  const labs = activities.filter((a) => a.kind === "lab" || a.kind === "scenario");

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <Link href="/learning/catalogue" style={{ font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
          ← Catalogue
        </Link>
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Level" value={LEVEL_LABEL[course.level]} foot={course.discipline ?? course.track} />
        <KpiTile label="Activities" value={String(activities.length)} foot={`${required.length} required`} />
        <KpiTile label="Estimated time" value={formatDuration(course.estimatedMinutes)} />
        <KpiTile
          label="Version"
          value={`v${course.version}`}
          // Versioning is the freeze discipline: editing a PUBLISHED course forks a new version
          // rather than rewriting it, so what somebody was taught and graded against stays intact.
          hint="Editing a published course opens a NEW version rather than changing this one — a completion always points at the exact material that was assessed."
        />
      </div>

      <Card
        title={course.title}
        headerRight={<StatusBadge label={course.status} />}
        hint={labs.length > 0 ? "This course includes hands-on work, not only reading." : undefined}
        style={{ marginBottom: 22 }}
      >
        {course.summary ? (
          <p style={{ margin: 0, font: "400 14px/1.7 var(--font-body)", color: "var(--erp-ink-60)" }}>{course.summary}</p>
        ) : (
          <EmptyNote>This course has no summary yet.</EmptyNote>
        )}
        {course.status !== "published" && (
          <p style={{ margin: "14px 0 0", font: "400 13px/1.6 var(--font-body)", color: "var(--status-warning-fg)" }}>
            This version is <strong>{course.status}</strong>. Only a published version can be added
            to a path or assigned to anybody.
          </p>
        )}
      </Card>

      {course.modules.length === 0 ? (
        <Card title="Contents">
          <EmptyNote>
            This course version has no modules yet. It is authored but not yet written — which is a
            different thing from being unreadable by you.
          </EmptyNote>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {course.modules.map((m, i) => (
            <Card key={m.id} title={`${i + 1}. ${m.title}`}>
              {m.summary && (
                <p style={{ margin: "0 0 14px", font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
                  {m.summary}
                </p>
              )}
              {m.activities.length === 0 ? (
                <EmptyNote>No activities in this module yet.</EmptyNote>
              ) : (
                <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
                  {m.activities.map((a) => (
                    <li
                      key={a.id}
                      style={{
                        display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap",
                        paddingBottom: 10, borderBottom: "0.5px solid var(--erp-hairline)",
                      }}
                    >
                      <span className="type-eyebrow" style={{ fontSize: 10, minWidth: 96 }}>
                        {KIND_LABEL[a.kind]}
                      </span>
                      <span style={{ font: "400 14px var(--font-body)", flex: 1, minWidth: 200 }}>
                        {a.title}
                        {!a.isRequired && (
                          <span style={{ marginLeft: 8, font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
                            optional
                          </span>
                        )}
                      </span>
                      <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
                        {formatDuration(a.estimatedMinutes)} · {GRADING_NOTE[a.grading]}
                        {/* The grading key is stripped server-side for everyone who is not
                            authoring the course. Said out loud so an author who opens this page
                            and sees no answers knows why, rather than reporting missing content. */}
                        {a.specRedacted ? " · answers hidden" : ""}
                        {a.passThreshold ? ` · pass at ${a.passThreshold}` : ""}
                        {/* An attempt cap is a fact the learner needs BEFORE the first attempt,
                            not a surprise on the last one. */}
                        {a.maxAttempts ? ` · ${a.maxAttempts} attempt${a.maxAttempts === 1 ? "" : "s"}` : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
