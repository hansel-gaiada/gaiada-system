import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listCourses, listPaths, getCompliance } from "@/lib/lms";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ModuleDisabled } from "@/components/ModuleDisabled";
import { isModuleOnForActiveCompany } from "@/lib/modules";

// Learning — the module's front door.
//
// Deliberately NOT under /hr. The LMS is its own module serving all eight departments; filing a
// company-wide capability under one department would have made Creative's or SEO's training
// silently depend on `hr` being served to them.
export default async function LearningHomePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  // The `lms` module answers 403/404 on every route while it is dark, and `soft()` turns that into
  // an empty list — which renders as "nothing is published" rather than "this is switched off".
  // Ask the gate first so the two never look alike.
  if (!(await isModuleOnForActiveCompany("lms"))) return <ModuleDisabled module="lms" label="Learning" />;

  const canSeeProgress = can(me, "lms.progress.view", tenant);
  const [courses, paths, compliance] = await Promise.all([
    listCourses(userId, tenant),
    listPaths(userId, tenant),
    // Only asked for when it may be answered — a 403 here would degrade to [] and render as "0
    // outstanding", which is the reassuring version of a wrong answer.
    canSeeProgress ? getCompliance(userId, tenant) : Promise.resolve([]),
  ]);

  const mandatoryPaths = paths.filter((p) => p.isMandatory);
  const outstanding = compliance.filter((r) => r.isMandatory).reduce((n, r) => n + r.outstanding, 0);
  const overdue = compliance.filter((r) => r.isMandatory).reduce((n, r) => n + r.overdue, 0);

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Courses" value={String(courses.length)} foot="published" />
        <KpiTile label="Paths" value={String(paths.length)} foot={`${mandatoryPaths.length} required of everyone`} />
        {canSeeProgress && <KpiTile label="Outstanding" value={String(outstanding)} foot="on required training" />}
        {canSeeProgress && <KpiTile label="Overdue" value={String(overdue)} />}
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <Card
          title="My learning"
          headerRight={<Link href="/me/learning" className="lux-btn lux-btn--ghost lux-btn--sm">Open</Link>}
        >
          <p style={{ margin: 0, font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
            What is assigned to you, what is due, and the certificates you hold. Certificates are
            written to your HR file, so their expiry rides the same sweep as your contracts.
          </p>
        </Card>

        <Card
          title="Catalogue"
          headerRight={<Link href="/learning/catalogue" className="lux-btn lux-btn--ghost lux-btn--sm">Browse</Link>}
        >
          <p style={{ margin: 0, font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
            Every published course and path, across all departments and all four levels —
            foundation through lead. Open to everyone: training you cannot see is a support ticket,
            not a security posture.
          </p>
        </Card>

        {canSeeProgress && (
          <Card
            title="Compliance"
            headerRight={<Link href="/learning/compliance" className="lux-btn lux-btn--ghost lux-btn--sm">Open</Link>}
          >
            <p style={{ margin: 0, font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
              Completion against required training, by path — outstanding and overdue counts rather
              than a per-person score dump.
            </p>
          </Card>
        )}
      </div>

      {paths.length === 0 && (
        <Card title="Nothing published yet" style={{ marginTop: 22 }}>
          <EmptyNote>
            The <strong>lms</strong> module is enabled for this company, but nothing has been
            published into it yet. A course must be <strong>published</strong> before it can join a
            path, and a path must be published before it can be assigned — drafts are invisible
            here by design, so this means nobody has published, not that authoring is broken.
          </EmptyNote>
        </Card>
      )}
    </>
  );
}
