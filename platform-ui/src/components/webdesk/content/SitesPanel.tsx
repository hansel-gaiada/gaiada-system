import Link from "next/link";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card } from "@/components/ui";
import type { SitesBody } from "@/lib/webdeskContentModel";
import "./content.css";

/** `content` — the sites this company can edit. Zero is a REAL answer here (the read succeeded and the
 *  company has none), which is why it is only reachable on an `ok` result. */
export function SitesPanel({ sites, contentBase }: { sites: SitesBody; contentBase: string }) {
  const rows = sites.tenants.flatMap((t) => t.sites.map((s) => ({ t, s })));
  if (rows.length === 0) {
    return (
      <Card title="Websites">
        <EmptyNote>WebDesk reports no sites for this company yet. A site appears here once it has been provisioned in WebDesk and linked to this company.</EmptyNote>
      </Card>
    );
  }
  return (
    <div className="wc-sites" data-testid="sites-list">
      {rows.map(({ t, s }) => (
        <Link key={`${t.slug}/${s.siteId}`} className="wc-site" href={`${contentBase}/${encodeURIComponent(t.slug)}/${encodeURIComponent(s.siteId)}`}>
          <span className="wc-site__name">{s.name}</span>
          <span className="wc-muted">{t.slug} · {s.kind} · {t.locales.join(", ")} (default {t.defaultLocale})</span>
          <span className="wc-muted">{s.environments.map((e) => e.name).join(" · ") || "no environments"}</span>
        </Link>
      ))}
    </div>
  );
}
