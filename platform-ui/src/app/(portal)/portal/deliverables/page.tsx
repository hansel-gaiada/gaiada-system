import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listPortalDeliverables } from "@/lib/portal-data";
import { isPastDue, portalDate } from "@/lib/portal";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalPageHead, PortalStatus } from "@/components/portal/PortalBits";

// CP-11 — what the client has actually received, grouped by project, with the files attached.
//
// Downloads go through `/api/:t/portal/files/:id` — the PORTAL's own route, not the staff `/files` one.
// The staff route authorizes with `{kind: "deliverable"}`, which no Cerbos policy grants the `client`
// role, so it would 403 however the portal linked to it; granting that role would have opened every
// deliverable in the tenant. The portal route instead walks the file's parent entity through the
// caller's client/project scope. See portal-commerce.controller.ts's download header.
//
// Files link out with a plain `<a>` and no `target`: this is a download (the server sends
// `content-disposition: attachment`), so opening a tab would flash an empty one and close it.
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function PortalDeliverablesPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>No workspace selected.</EmptyNote>;

  const deliverables = await listPortalDeliverables(userId, tenant);
  const now = new Date();

  // Grouped by project, preserving the BFF's due-date ordering within each group. A flat list across
  // projects is unusable the moment a client has two of them running.
  const byProject = new Map<string, { name: string; items: typeof deliverables }>();
  for (const d of deliverables) {
    const g = byProject.get(d.projectId) ?? { name: d.projectName, items: [] };
    g.items.push(d);
    byProject.set(d.projectId, g);
  }

  return (
    <>
      <PortalPageHead
        eyebrow="Your work"
        title="Deliverables"
        lead="Everything we owe you and everything we've handed over, with the files."
        actions={<PortalLive topics={["deliverables"]} />}
      />

      {deliverables.length === 0 ? (
        <EmptyNote>No deliverables yet.</EmptyNote>
      ) : (
        <div className="cp-stack">
          {[...byProject.entries()].map(([projectId, group]) => (
            <Card
              key={projectId}
              title={group.name}
              headerRight={
                <Link href={`/portal/projects/${projectId}`} style={{ font: "500 12px var(--font-body)", color: "var(--erp-accent)", textDecoration: "none" }}>
                  Open project →
                </Link>
              }
            >
              <div style={{ display: "grid", gap: 16 }}>
                {group.items.map((d) => {
                  const late = isPastDue(d.dueDate, now) && !["delivered", "approved", "done"].includes(d.status);
                  return (
                    <div key={d.id}>
                      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                        <span style={{ font: "500 14px/1.4 var(--font-body)", color: "var(--ink-strong)" }}>{d.name}</span>
                        <PortalStatus status={d.status} />
                        <span className="cp-need__spacer" />
                        <span style={{
                          font: "400 12px var(--font-body)",
                          color: late ? "var(--status-danger-fg)" : "var(--ink-subtle)",
                          fontWeight: late ? 500 : 400,
                        }}>
                          {d.dueDate ? `${late ? "Was due" : "Due"} ${portalDate(d.dueDate)}` : "No date set"}
                        </span>
                      </div>
                      {d.files && d.files.length > 0 ? (
                        <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 5 }}>
                          {d.files.map((f) => (
                            <li key={f.id} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                              {/* A link-only ("reference") attachment has a `url` and no stored bytes;
                                  linking it to the download route would 404. Both shapes are real in
                                  `files`, so both are handled rather than assuming every row has bytes. */}
                              {f.url ? (
                                <a href={f.url} rel="noopener noreferrer" target="_blank"
                                   style={{ font: "500 13px var(--font-body)", color: "var(--erp-accent)" }}>
                                  {f.filename}
                                </a>
                              ) : (
                                <a href={`/api/${tenant}/portal/files/${f.id}`}
                                   style={{ font: "500 13px var(--font-body)", color: "var(--erp-accent)" }}>
                                  {f.filename}
                                </a>
                              )}
                              <span style={{ font: "400 11px var(--font-body)", color: "var(--ink-faint)" }}>
                                {formatBytes(f.byteSize)}
                                {f.url ? " · link" : ""}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div style={{ font: "400 12px/1.6 var(--font-body)", color: "var(--ink-subtle)", marginTop: 4 }}>
                          {["delivered", "approved", "done"].includes(d.status)
                            // Delivered with no attachment is normal (a deployed site, a live campaign) —
                            // saying so prevents "where is my file?" on work that had no file.
                            ? "Delivered — no file attached to this item."
                            : "No files yet."}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
