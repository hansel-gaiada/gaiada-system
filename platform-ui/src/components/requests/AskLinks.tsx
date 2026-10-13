import Link from "next/link";
import type { OrgNode } from "@/lib/org";
import { departmentForWorkspace } from "@/lib/workspaceAccess";
import { REQUEST_TARGETS, type RequestTargetKey } from "@/lib/requests";
import "./requests.css";

/** "Ask Creatives for assets" and "Ask Web Dev", on the request lists. Each is shown only where the company HAS the
 *  receiving department (the same rule as the registry's `hasWorkspace` gate, DW-5f), and none for a tree that could not be
 *  read (`root` null): a link to a form that can only say "no such department" is not offered. */
export function AskLinks({ root, vertical, exclude }: { root: OrgNode | null; vertical: string | null | undefined; exclude?: RequestTargetKey }) {
  const links = (Object.keys(REQUEST_TARGETS) as RequestTargetKey[])
    .filter((k) => k !== exclude && departmentForWorkspace(root, vertical, k) !== null)
    .map((k) => ({
      key: k,
      href: `/requests/new?to=${k}`,
      label: k === "creatives" ? "Ask Creatives for assets" : "Ask Web Dev",
    }));
  if (links.length === 0) return null;
  return (
    <div className="req-asks">
      {links.map((l) => (
        <Link key={l.key} href={l.href} className="lux-btn lux-btn--ghost lux-btn--sm">{l.label}</Link>
      ))}
    </div>
  );
}
