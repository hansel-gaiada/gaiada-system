import Link from "next/link";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card } from "@/components/ui";
import { authorLabel, type FieldChange, type ItemSummary, type VersionListBody } from "@/lib/webdeskContentModel";
import { formatDateTime } from "@/lib/format";
import type { SiteScope } from "@/lib/webdeskContentActions";
import { RestoreButton } from "./RestoreButton";
import "./content.css";

/** `…/[slug]/history` — versions (author resolved in the ERP), diff against live, Restore as draft. */
export function HistoryPanel({
  scope, item, versions, authors, historyHref, editorHref, compare,
}: {
  scope: SiteScope;
  item: ItemSummary;
  versions: VersionListBody;
  authors: Record<string, string>;
  historyHref: string;
  editorHref: string;
  /** The diff for `?compare=n`, when asked for. `null` = not asked. */
  compare: { version: number; liveVersion: number | null; changes: FieldChange[] } | { version: number; problem: string } | null;
}) {
  return (
    <div className="wc-page">
      <p className="wc-lede">
        Head is v{item.headVersion}; {item.publishedVersion !== null ? `v${item.publishedVersion} is live` : "nothing is live yet"}.{" "}
        <Link href={editorHref}>Back to the editor</Link>
      </p>

      {compare && (
        "problem" in compare ? (
          <Card title={`Diff of v${compare.version}`}><EmptyNote>{compare.problem}</EmptyNote></Card>
        ) : (
          <Card title={`v${compare.version} against live${compare.liveVersion !== null ? ` (v${compare.liveVersion})` : ""}`}>
            {compare.changes.length === 0 ? (
              <EmptyNote>No field differs between these two versions.</EmptyNote>
            ) : (
              <div className="wc-diff" data-testid="diff">
                <div className="wc-diff__head">Live</div><div className="wc-diff__head">v{compare.version}</div>
                {compare.changes.map((c) => (
                  <div key={c.pointer} style={{ display: "contents" }}>
                    <div className="wc-diff__label">{c.label} <span className="wc-muted">({c.kind})</span></div>
                    <div className="wc-diff__cell wc-diff__cell--before">{c.before}</div>
                    <div className="wc-diff__cell wc-diff__cell--after">{c.after}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )
      )}

      {versions.versions.length === 0 ? (
        <Card title="Versions"><EmptyNote>No versions were returned for this item.</EmptyNote></Card>
      ) : (
        <div className="wc-scroll">
          <table className="wc-table" data-testid="versions-table">
            <thead><tr><th scope="col">Version</th><th scope="col">When</th><th scope="col">Author</th><th scope="col">Note</th><th scope="col">Hash</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {versions.versions.map((v) => (
                <tr key={v.version}>
                  <td>v{v.version}{v.version === item.headVersion ? <> <span className="wc-chip">head</span></> : null}{v.version === item.publishedVersion ? <> <span className="wc-chip wc-chip--ok">live</span></> : null}</td>
                  <td>{formatDateTime(v.createdAt)}</td>
                  <td>{authorLabel(v.createdBy, authors)}</td>
                  <td>{v.note ?? <span className="wc-muted">—</span>}</td>
                  <td className="wc-mono">{v.contentHash.slice(0, 10)}</td>
                  <td>
                    <span className="wc-publish__actions">
                      {item.publishedVersion !== null && v.version !== item.publishedVersion && (
                        <Link href={`${historyHref}&compare=${v.version}`} className="lux-btn lux-btn--ghost lux-btn--sm">Diff against live</Link>
                      )}
                      {v.version !== item.headVersion && (
                        <RestoreButton scope={scope} itemId={item.itemId} version={v.version} baseVersion={item.headVersion} editorHref={editorHref} />
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {versions.page.hasMore && <p className="wc-muted">Older versions exist beyond the first {versions.page.limit}; paging is not wired yet.</p>}
    </div>
  );
}
