import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getCourse, formatDuration, LEVEL_LABEL, type Activity } from "@/lib/lms";
import { addModule, addActivity, deleteActivity, publishCourse, retireCourse } from "@/lib/lmsActions";
import { Card, KpiTile, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ModuleDisabled } from "@/components/ModuleDisabled";
import { isModuleOnForActiveCompany } from "@/lib/modules";
import { LmsActionButton } from "@/components/lms/LmsActionButton";
import { ModuleForm, ActivityForm } from "@/components/lms/AuthoringForms";

// Learning › Authoring › one course — modules, activities, and the publish decision.
//
// ⚠ THE RULE THIS PAGE EXISTS TO MAKE VISIBLE: editing a PUBLISHED course does not edit it. The
//   backend forks a new DRAFT version carrying the structure across, and the published version
//   goes on saying exactly what it said. An author who does not understand that will "fix a typo"
//   in live training and find out weeks later that nobody ever saw the fix.
const KIND_LABEL: Record<Activity["kind"], string> = {
  read: "Reading", watch: "Video", quiz: "Quiz", scenario: "Scenario", lab: "Hands-on lab",
};

export default async function AuthorCoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  if (!(await isModuleOnForActiveCompany("lms"))) return <ModuleDisabled module="lms" label="Learning" />;
  if (!can(me, "lms.authoring", tenant)) {
    return <EmptyNote>Authoring training is for department heads, HR and company administrators.</EmptyNote>;
  }
  const canPublish = can(me, "lms.publish", tenant);

  const { courseId } = await params;
  // ?includeAnswers=1 — this is the AUTHORING read, and the backend re-authorizes it for `update`.
  // An author editing a quiz must see what it grades against; a learner asking for the same thing
  // is refused rather than quietly redacted. If this call 403s, the person is not this course's
  // author, and an error is the honest outcome.
  const course = await getCourse(userId, tenant, courseId, { includeAnswers: true });

  const activities = course.modules.flatMap((m) => m.activities);
  const isPublished = course.status === "published";

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <Link href="/learning/authoring" style={{ font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
          ← Authoring
        </Link>
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Status" value={<StatusBadge label={course.status} />} foot={`v${course.version}`} />
        <KpiTile label="Modules" value={String(course.modules.length)} />
        <KpiTile label="Activities" value={String(activities.length)} foot={`${activities.filter((a) => a.isRequired).length} required`} />
        <KpiTile label="Estimated time" value={formatDuration(course.estimatedMinutes)} />
      </div>

      <Card
        title={course.title}
        headerRight={
          <span style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {canPublish && !isPublished && (
              <LmsActionButton
                action={publishCourse} fields={{ courseId }} tone="solid"
                label="Publish" pendingLabel="Publishing…"
                confirm={
                  "Publishing makes this version assignable and freezes what people will be certified " +
                  "against. Later edits open a NEW version rather than changing this one. Publish?"
                }
              />
            )}
            {canPublish && isPublished && (
              <LmsActionButton
                action={retireCourse} fields={{ courseId }}
                label="Retire" pendingLabel="Retiring…"
                confirm={
                  "Retiring withdraws this course from new assignments. Anyone part-way through keeps " +
                  "their enrolment and nothing is deleted. Retire?"
                }
              />
            )}
            <Link href={`/learning/courses/${courseId}`} className="lux-btn lux-btn--ghost lux-btn--sm">
              View as a learner
            </Link>
          </span>
        }
        style={{ marginBottom: 22 }}
      >
        <p style={{ margin: 0, font: "400 14px/1.7 var(--font-body)", color: "var(--erp-ink-60)" }}>
          {course.summary || "No summary yet."}
        </p>
        <p style={{ margin: "12px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
          <strong>{course.courseKey}</strong> · {course.track === "general" ? "general track" : course.unitNodeId}
          {course.discipline ? ` · ${course.discipline}` : ""} · {LEVEL_LABEL[course.level]}
        </p>
        {isPublished && (
          <p style={{ margin: "14px 0 0", font: "400 13px/1.6 var(--font-body)", color: "var(--status-warning-fg)" }}>
            This version is <strong>live</strong>. Adding a module or activity here changes what
            people are taking right now; editing the course&apos;s own fields instead opens a new
            draft version and leaves this one alone.
          </p>
        )}
      </Card>

      {course.modules.length === 0 ? (
        <Card title="Contents" style={{ marginBottom: 22 }}>
          <EmptyNote>
            No modules yet. A module is a chapter; the activities inside it are what a learner
            actually does.
          </EmptyNote>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 22 }}>
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
                <ol style={{ margin: "0 0 16px", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 12 }}>
                  {m.activities.map((a) => (
                    <li key={a.id} style={{ paddingBottom: 12, borderBottom: "0.5px solid var(--erp-hairline)" }}>
                      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                        <span className="type-eyebrow" style={{ fontSize: 10, minWidth: 96 }}>{KIND_LABEL[a.kind]}</span>
                        <span style={{ font: "400 14px var(--font-body)", flex: 1, minWidth: 200 }}>
                          {a.title}
                          {!a.isRequired && (
                            <span style={{ marginLeft: 8, font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
                              optional
                            </span>
                          )}
                        </span>
                        <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
                          {a.grading} {a.passThreshold ? `· pass at ${a.passThreshold}` : ""}
                          {a.maxAttempts ? ` · ${a.maxAttempts} attempts` : ""}
                        </span>
                        <LmsActionButton
                          action={deleteActivity} fields={{ activityId: a.id, courseId }}
                          label="Remove" pendingLabel="Removing…"
                          confirm={
                            `Remove "${a.title}"? Anyone who has already attempted it keeps their ` +
                            `attempt record — this removes the activity, not the history.`
                          }
                        />
                      </div>
                      {a.kind === "quiz" && (
                        // The answer key, visible because this is the authoring read. Shown as a
                        // count rather than dumped: an author needs to know the quiz is gradeable,
                        // and a quiz with zero questions grades everybody as wrong.
                        <p style={{ margin: "8px 0 0 108px", font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
                          {Array.isArray((a.spec as { questions?: unknown[] })?.questions)
                            ? `${((a.spec as { questions: unknown[] }).questions).length} question(s), answers included in this view`
                            : "⚠ no `questions` array — nothing could pass this quiz"}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              <ActivityForm add={addActivity} moduleId={m.id} courseId={courseId} nextOrder={(m.activities.length + 1) * 10} />
            </Card>
          ))}
        </div>
      )}

      <ModuleForm add={addModule} courseId={courseId} nextOrder={(course.modules.length + 1) * 10} />
    </>
  );
}
