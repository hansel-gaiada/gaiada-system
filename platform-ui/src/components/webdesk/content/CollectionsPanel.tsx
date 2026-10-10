import Link from "next/link";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card } from "@/components/ui";
import { collectionLabel, groupCollections, type CollectionSummary } from "@/lib/webdeskContentModel";
import { formatDateTime } from "@/lib/format";
import "./content.css";

/** `content/[tenant]/[site]` — collections grouped by `composition.ui.group`, each with its label,
 *  items per locale, live count and PENDING CHANGES (§10). */
export function CollectionsPanel({ collections, siteBase }: { collections: CollectionSummary[]; siteBase: string }) {
  if (collections.length === 0) {
    return (
      <Card title="Collections">
        <EmptyNote>This site has no collections yet. Collections are created when a content contract is applied to the site in WebDesk.</EmptyNote>
      </Card>
    );
  }
  return (
    <div className="wc-page" data-testid="collections">
      {groupCollections(collections).map(({ group, collections: cs }) => (
        <section key={group} aria-label={group}>
          <h2 className="wc-group-head">{group}</h2>
          <div className="wc-scroll">
            <table className="wc-table">
              <thead>
                <tr><th scope="col">Collection</th><th scope="col">Items by locale</th><th scope="col" className="wc-table__num">Live</th><th scope="col" className="wc-table__num">Pending changes</th><th scope="col">Updated</th></tr>
              </thead>
              <tbody>
                {cs.map((c) => (
                  <tr key={c.key}>
                    <td>
                      <Link href={`${siteBase}/${encodeURIComponent(c.key)}`}>{collectionLabel(c)}</Link>
                      {c.composition.singleton && <span className="wc-muted"> · single document</span>}
                      {c.composition.ui?.description && <div className="wc-muted">{c.composition.ui.description}</div>}
                    </td>
                    <td>{Object.entries(c.counts.byLocale).map(([l, n]) => `${l} ${n}`).join(" · ") || "—"} <span className="wc-muted">({c.counts.items} total)</span></td>
                    <td className="wc-table__num">{c.counts.live}</td>
                    <td className="wc-table__num">{c.counts.pendingChanges > 0 ? <span className="wc-chip wc-chip--warn">{c.counts.pendingChanges}</span> : 0}</td>
                    <td>{formatDateTime(c.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
