import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getCourse, formatDuration } from "@/lib/lms";
import { submitQuiz, submitLab } from "@/lib/lmsLearnActions";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ModuleDisabled } from "@/components/ModuleDisabled";
import { isModuleOnForActiveCompany } from "@/lib/modules";
import { QuizPlayer, type QuizQuestion } from "@/components/lms/QuizPlayer";
import { LabPlayer, type LabFile } from "@/components/lms/LabPlayer";

// Learning › course › ONE ACTIVITY — the piece that was missing entirely. Before this route
// existed, the course viewer listed an activity's title as plain text: a learner could see what
// training they were assigned and could not open any of it. This is the player.
//
// `getCourse` does not degrade (see lib/lms.ts), so a course this learner cannot read surfaces as a
// genuine error rather than a confusing 404 here — the module gate below catches the one 404 that
// IS explainable (the LMS switched off for this company).
//
// ⚠ `spec` ARRIVES REDACTED for a quiz/lab/scenario — `specRedacted: true`, no `answer` field, no
//   `gradingSpec`. This page never assumes otherwise: the quiz form works entirely off `prompt` /
//   `options` / `explanation`, and grading happens server-side on submit.
export default async function ActivityPage({
  params,
}: {
  params: Promise<{ id: string; activityId: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  if (!(await isModuleOnForActiveCompany("lms"))) return <ModuleDisabled module="lms" label="Learning" />;

  const { id, activityId } = await params;
  const course = await getCourse(userId, tenant, id);
  const activity = course.modules.flatMap((m) => m.activities).find((a) => a.id === activityId);
  if (!activity) notFound();

  const spec = activity.spec as Record<string, unknown>;

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <Link href={`/learning/courses/${id}`} style={{ font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
          ← {course.title}
        </Link>
      </div>

      <Card
        title={activity.title}
        headerRight={
          <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
            {formatDuration(activity.estimatedMinutes)}
            {activity.isRequired ? " · required" : " · optional"}
            {activity.maxAttempts ? ` · ${activity.maxAttempts} attempt${activity.maxAttempts === 1 ? "" : "s"}` : ""}
          </span>
        }
        style={{ marginBottom: 22 }}
      >
        {null}
      </Card>

      {activity.kind === "read" && (
        <Card title="Reading">
          {typeof spec.body === "string" && spec.body ? (
            <p style={{ margin: 0, font: "400 14px/1.8 var(--font-body)", color: "var(--erp-ink-60)", whiteSpace: "pre-wrap" }}>
              {spec.body}
            </p>
          ) : (
            <EmptyNote>This reading has no body yet.</EmptyNote>
          )}
        </Card>
      )}

      {activity.kind === "watch" && (
        <Card title="Video">
          {typeof spec.url === "string" && spec.url ? (
            <p style={{ margin: "0 0 14px" }}>
              <a href={spec.url} target="_blank" rel="noreferrer" style={{ color: "var(--erp-accent)" }}>
                {spec.url}
              </a>
            </p>
          ) : (
            <EmptyNote>No video link set for this activity yet.</EmptyNote>
          )}
          {typeof spec.body === "string" && spec.body && (
            <p style={{ margin: 0, font: "400 14px/1.8 var(--font-body)", color: "var(--erp-ink-60)", whiteSpace: "pre-wrap" }}>
              {spec.body}
            </p>
          )}
        </Card>
      )}

      {activity.kind === "quiz" &&
        (Array.isArray(spec.questions) && (spec.questions as unknown[]).length > 0 ? (
          <QuizPlayer
            activityId={activity.id}
            courseId={id}
            questions={spec.questions as QuizQuestion[]}
            passThreshold={activity.passThreshold}
            submit={submitQuiz}
          />
        ) : (
          <Card title="Quiz">
            <EmptyNote>This quiz has no questions yet.</EmptyNote>
          </Card>
        ))}

      {activity.kind === "lab" && (
        <LabPlayer
          activityId={activity.id}
          courseId={id}
          brief={typeof spec.brief === "string" ? spec.brief : typeof spec.body === "string" ? spec.body : ""}
          starter={
            (Array.isArray(spec.starter) ? (spec.starter as LabFile[]) : undefined) ??
            (Array.isArray(spec.files) ? (spec.files as LabFile[]) : [])
          }
          submit={submitLab}
        />
      )}

      {activity.kind === "scenario" && (
        <Card title="Scenario">
          {typeof spec.brief === "string" && spec.brief ? (
            <p style={{ margin: 0, font: "400 14px/1.8 var(--font-body)", color: "var(--erp-ink-60)", whiteSpace: "pre-wrap" }}>
              {spec.brief}
            </p>
          ) : (
            <EmptyNote>No brief set for this scenario yet.</EmptyNote>
          )}
          <p style={{ margin: "16px 0 0", font: "400 13px var(--font-body)", color: "var(--erp-ink-60)" }}>
            This activity is reviewed by a person — there is no self-graded submission form here.
          </p>
        </Card>
      )}
    </>
  );
}
