import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { toolkitFor } from "@/lib/deptToolkits";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Build Tools — the launchpad. Buttons that open the external tools the department
// builds with (Claude Code, Claude, Claude Design, GitHub, Figma, VS Code …). The
// set comes from the department's toolkit so each department gets its own launchpad.
export default async function BuildToolsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  const { launchers } = toolkitFor(dept.name);

  return (
    <Card title="Launchpad">
      {launchers.length === 0 ? (
        <EmptyNote>No build tools configured for this department yet.</EmptyNote>
      ) : (
        <div className="dept-launchers">
          {launchers.map((l) => (
            <a key={l.key} href={l.url} target="_blank" rel="noopener noreferrer" className="dept-launcher">
              <span className="dept-launcher__glyph" aria-hidden="true">{l.glyph}</span>
              <span style={{ minWidth: 0 }}>
                <span className="dept-launcher__label">{l.label}</span>
                <span className="dept-launcher__desc" style={{ display: "block" }}>{l.desc}</span>
              </span>
              <span className="dept-launcher__arrow" aria-hidden="true">↗</span>
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}
