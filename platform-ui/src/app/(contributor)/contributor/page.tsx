import { contributorCtx } from "@/lib/contributorServer";
import { loadAssignments } from "@/lib/contributorData";
import { AssignmentsList } from "@/components/contributor/AssignmentsList";
import "@/components/webdesk/content/content.css";

export const dynamic = "force-dynamic";

// M5-W1f: My assignments. The layout has already turned a fenced (no second factor) session into the notice, so a `fenced` here can only be a
// race; it renders nothing rather than guessing.
export default async function ContributorHomePage() {
  const c = await contributorCtx();
  if (c.kind !== "ok") return null;
  if (!c.company) {
    return <p data-testid="assignments-no-engagement" style={{ margin: 0, font: "400 14px/1.6 var(--font-body)", color: "var(--ink-muted)" }}>You have no live engagement right now, so there is nothing to show. It may have ended or expired: ask the person who invited you.</p>;
  }
  const view = await loadAssignments(c.userId, c.company, c.me.userId);
  return (
    <div className="wc-page" style={{ display: "grid", gap: 16 }}>
      <h1 style={{ margin: 0, font: "600 22px var(--font-display)", color: "var(--ink)" }}>My assignments</h1>
      <p className="wc-lede">The items you can write, translate or review. Open one to edit it, send it for review, read the comments and preview your draft.</p>
      <AssignmentsList view={view} />
    </div>
  );
}
