import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPath, LEVEL_LABEL } from "@/lib/lms";
import { Card, KpiTile, StatusBadge, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ModuleDisabled } from "@/components/ModuleDisabled";
import { isModuleOnForActiveCompany } from "@/lib/modules";

// Learning › a single PATH — its ordered courses, each a link into the read-only course viewer.
//
// This is the page `/me/learning` was missing entirely: a learner's assigned row rendered as a
// plain <span> with nowhere to click. `getPath` does NOT degrade (see lib/lms.ts) for the same
// reason `getCourse` doesn't — an empty path reads as "nothing to do here", which is the single
// worst wrong answer this surface can give somebody with mandatory training outstanding.
export default async function LearningPathPage({ params }: { params: Promise<{ pathId: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  if (!(await isModuleOnForActiveCompany("lms"))) return <ModuleDisabled module="lms" label="Learning" />;

  const { pathId } = await params;
  const path = await getPath(userId, tenant, pathId);

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <Link href="/me/learning" style={{ font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
          ← My learning
        </Link>
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile
          label="Level"
          value={LEVEL_LABEL[path.level]}
          foot={path.track === "general" ? "Everyone" : (path.discipline ?? "department")}
        />
        <KpiTile label="Courses" value={String(path.courses.length)} />
        <KpiTile
          label="Certificate"
          value={
            path.certificationValidMonths
              ? `valid ${path.certificationValidMonths}mo`
              : path.certificationLabel
                ? "does not expire"
                : "—"
          }
        />
      </div>

      <Card
        title={path.title}
        headerRight={<StatusBadge label={path.status} />}
        hint="Courses are ORDERED — one marked 'requires previous' only unlocks once you have passed the one before it."
        style={{ marginBottom: 22 }}
      >
        {path.summary ? (
          <p style={{ margin: 0, font: "400 14px/1.7 var(--font-body)", color: "var(--erp-ink-60)" }}>{path.summary}</p>
        ) : (
          <EmptyNote>This path has no summary yet.</EmptyNote>
        )}
        {path.isMandatory && (
          <p style={{ margin: "14px 0 0", font: "400 13px/1.6 var(--font-body)", color: "var(--status-warning-fg)" }}>
            This path is <strong>required</strong>.
          </p>
        )}
      </Card>

      <Card title="Courses in this path">
        {path.courses.length === 0 ? (
          <EmptyNote>
            This path has no courses yet — it is assigned but not yet built out, which is a different
            thing from being unreadable by you.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "#" }, { label: "Course" }, { label: "Level" }, { label: "" }]}
            rows={path.courses.map((c) => [
              String(c.position),
              <Link key={c.id} href={`/learning/courses/${c.id}`} style={{ color: "var(--erp-accent)" }}>
                {c.title}
              </Link>,
              LEVEL_LABEL[c.level],
              c.isOptional ? (
                <span key={`${c.id}-tag`} className="type-eyebrow" style={{ fontSize: 10 }}>optional</span>
              ) : c.requiresPrevious ? (
                <span key={`${c.id}-tag`} className="type-eyebrow" style={{ fontSize: 10 }}>requires previous</span>
              ) : (
                ""
              ),
            ])}
          />
        )}
      </Card>
    </>
  );
}
