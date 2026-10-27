// SCP-1k, SCP-3d — the client page's tabs, by `?tab=` (Plan, Stories, Calendar, Feed preview, List, Client profile). Plain links: the current one is `aria-current`.
import Link from "next/link";
import { CLIENT_TABS, clientHref, type ClientTab } from "@/lib/socialClient";

export function ClientTabs({ deptId, engagementId, active }: { deptId: string; engagementId: string; active: ClientTab }) {
  return (
    <nav className="scp-ctabs" aria-label="This client">
      {CLIENT_TABS.map((t) => (
        <Link key={t.key} href={clientHref(deptId, engagementId, t.key)} className="scp-ctab" aria-current={t.key === active ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
