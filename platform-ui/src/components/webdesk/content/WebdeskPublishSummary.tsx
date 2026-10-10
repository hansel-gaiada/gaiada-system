import Link from "next/link";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { describeFailure, getItem } from "@/lib/webdeskContent";
import { listDepartments } from "@/lib/departments";
import { deptSlug } from "@/lib/deptToolkits";
import { parseWebdeskPublishArgs, publishStateLabel, type Lint, type WebdeskPublishArgs } from "@/lib/webdeskContentModel";
import { formatDateTime } from "@/lib/format";
import "./content.css";

// The approvals detail page's renderer for origin `webdesk` (write-plane design §10, "approvals/[id]"):
// "items, live vs requested diff links, lint counts, rebuild target". It is what an approver reads
// before saying yes to something public and crawler-irreversible, so it never shows a confident
// summary built on a guess:
//   • `tool_args` is unknown JSON until `parseWebdeskPublishArgs` says otherwise — a payload that does
//     not match the publish format renders as "unrecognised", not as an empty item list;
//   • every item is READ from WebDesk (at the REQUESTED version) rather than described from the
//     arguments alone; a row that cannot be read says so;
//   • the read is capped (a bulk import names hundreds of items); the summary says how many it read.

export const SUMMARY_READ_CAP = 25;

export interface SummaryRow {
  itemId: string;
  version: number;
  contentHash: string | null;
  resolved: {
    collectionKey: string; slug: string; locale: string;
    publishedVersion: number | null; headVersion: number; publishState: string; lint: Lint;
  } | null;
  /** Why `resolved` is null. */
  problem: string | null;
}

export async function WebdeskPublishSummary({
  userId, company, toolArgs, workflowId,
}: {
  userId: string;
  company: string;
  toolArgs: unknown;
  workflowId: string;
}) {
  const args = parseWebdeskPublishArgs(toolArgs);
  if (!args) return <WebdeskPublishSummaryView args={null} rows={[]} unread={0} workflowId={workflowId} deptId={null} />;

  const slice = args.items.slice(0, SUMMARY_READ_CAP);
  const [rows, deptId] = await Promise.all([
    Promise.all(slice.map(async (it): Promise<SummaryRow> => {
      const r = await getItem(userId, company, args.tenantSlug, args.siteId, it.itemId, it.version);
      if (r.kind !== "ok") return { itemId: it.itemId, version: it.version, contentHash: it.contentHash, resolved: null, problem: describeFailure(r) };
      return {
        itemId: it.itemId, version: it.version, contentHash: it.contentHash, problem: null,
        resolved: {
          collectionKey: r.data.item.collectionKey, slug: r.data.item.slug, locale: r.data.item.locale,
          publishedVersion: r.data.item.publishedVersion, headVersion: r.data.item.headVersion, publishState: r.data.item.publishState,
          lint: r.data.lint,
        },
      };
    })),
    // Cosmetic: the deep links need the Web Dev department's id. No department found => no links, not a failure.
    listDepartments(userId, company).then((ds) => ds.find((d) => deptSlug(d.name) === "web-dev")?.id ?? null).catch(() => null),
  ]);
  return <WebdeskPublishSummaryView args={args} rows={rows} unread={args.items.length - slice.length} workflowId={workflowId} deptId={deptId} />;
}

function sumLint(rows: SummaryRow[]): { tokens: number; markers: Record<string, number>; unreadable: number; unchecked: number; checked: number } {
  let tokens = 0;
  let unreadable = 0;
  let unchecked = 0; // read fine, but WebDesk could not RUN the lint: its empty lists are not a finding
  let checked = 0;
  const markers: Record<string, number> = {};
  for (const r of rows) {
    if (!r.resolved) { unreadable++; continue; }
    if (r.resolved.lint.unavailable !== undefined) { unchecked++; continue; }
    checked++;
    tokens += r.resolved.lint.unresolvedTokens.length;
    for (const [k, n] of Object.entries(r.resolved.lint.markers)) markers[k] = (markers[k] ?? 0) + n;
  }
  return { tokens, markers, unreadable, unchecked, checked };
}

/** Pure view — unit-tested without a backend. */
export function WebdeskPublishSummaryView({
  args, rows, unread, workflowId, deptId,
}: {
  args: WebdeskPublishArgs | null;
  rows: SummaryRow[];
  /** Items named by the request that were NOT read (over the cap). */
  unread: number;
  workflowId: string;
  deptId: string | null;
}) {
  if (!args) {
    return (
      <Card title="WebDesk publish">
        <div className="wc-banner wc-banner--warn" role="note" data-testid="webdesk-summary-unrecognised">
          <span className="wc-banner__body"><strong>Unrecognised request.</strong> This approval is marked as a WebDesk request, but its arguments are not in the publish format
            (<code>tenantSlug</code>, <code>siteId</code>, <code>items[]</code>), so no summary can be shown. Decide it only if you can verify it another way.</span>
        </div>
      </Card>
    );
  }

  const isSchedule = workflowId === "content.schedule";
  const total = args.items.length;
  const lint = sumLint(rows);
  const markerLine = Object.entries(lint.markers).filter(([, n]) => n > 0).map(([k, n]) => `${n} × [${k}: …]`).join(" · ");
  const siteBase = deptId ? `/departments/${deptId}/website/content/${encodeURIComponent(args.tenantSlug)}/${encodeURIComponent(args.siteId)}` : null;

  return (
    <div className="wc-summary" data-testid="webdesk-summary">
      <Card title={isSchedule ? "Scheduled publish" : "Publish to WebDesk"}>
        <div className="wc-summary__grid">
          <Fact label="Site">{args.tenantSlug} / {args.siteId}</Fact>
          <Fact label="Items">{total}{total === 1 ? " item" : " items"}</Fact>
          <Fact label="Rebuild">{args.rebuild ? `${args.rebuild} site, after publishing` : "none requested"}</Fact>
          {args.publishAt && <Fact label="Publish at">{formatDateTime(args.publishAt)}</Fact>}
          {args.bundleSha256 && <Fact label="Import bundle"><span className="wc-mono">{args.bundleSha256.slice(0, 16)}…</span></Fact>}
        </div>
        {args.counts && Object.keys(args.counts).length > 0 && (
          <p className="wc-publish__sub" data-testid="summary-counts">By collection: {Object.entries(args.counts).map(([k, n]) => `${k} ${n}`).join(" · ")}</p>
        )}
        <p className="wc-publish__sub">
          Approving publishes exactly the versions listed, then rebuilds the staging site. Publishing is not undone by
          rejecting later — only by unpublishing.
        </p>
        <p className="wc-publish__sub" data-testid="summary-lint">
          {lint.checked === 0 && lint.unchecked > 0 ? (
            // Every item that was read had a lint that could not run: no count exists, and "0" would be a made-up one.
            <>Placeholders (advisory, never blocking): couldn&apos;t be checked — this is not a statement that there are none.</>
          ) : (
            <>
              Placeholders (advisory, never blocking): {lint.tokens} unresolved token{lint.tokens === 1 ? "" : "s"}{markerLine ? ` · ${markerLine}` : ""}
              {rows.length < total ? ` — counted over the ${rows.length} item${rows.length === 1 ? "" : "s"} read, not all ${total}` : ""}
              {lint.unreadable > 0 ? ` (${lint.unreadable} could not be read)` : ""}
              {lint.unchecked > 0 ? ` (${lint.unchecked} couldn't be checked, so they are not counted)` : ""}.
            </>
          )}
        </p>
      </Card>

      <Card title="Items">
        {rows.length === 0 ? (
          <EmptyNote>The request names no items.</EmptyNote>
        ) : (
          <div className="wc-scroll">
            <table className="wc-table" data-testid="summary-items">
              <thead><tr><th scope="col">Item</th><th scope="col">Requested</th><th scope="col">Live now</th><th scope="col">Hash</th><th scope="col">Review</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.itemId}>
                    <td>
                      {r.resolved ? (
                        <>{r.resolved.collectionKey} · <span className="wc-mono">{r.resolved.slug}</span> · {r.resolved.locale}</>
                      ) : (
                        <><span className="wc-mono">{r.itemId.slice(0, 8)}</span> <span className="lux-field__error">couldn&apos;t be read ({r.problem})</span></>
                      )}
                    </td>
                    <td>v{r.version}</td>
                    <td>{r.resolved ? (r.resolved.publishedVersion !== null ? `v${r.resolved.publishedVersion}` : "not live") : "—"}{r.resolved ? <> <span className="wc-muted">({publishStateLabel(r.resolved.publishState)})</span></> : null}</td>
                    <td className="wc-mono">{r.contentHash ? r.contentHash.slice(0, 10) : "—"}</td>
                    <td>
                      {r.resolved && siteBase ? (
                        <span className="wc-publish__actions">
                          <Link href={`${siteBase}/${encodeURIComponent(r.resolved.collectionKey)}/${encodeURIComponent(r.resolved.slug)}?locale=${encodeURIComponent(r.resolved.locale)}`}>Open</Link>
                          {r.resolved.publishedVersion !== null && r.resolved.publishedVersion !== r.version && (
                            <Link href={`${siteBase}/${encodeURIComponent(r.resolved.collectionKey)}/${encodeURIComponent(r.resolved.slug)}/history?locale=${encodeURIComponent(r.resolved.locale)}&compare=${r.version}`}>Diff against live</Link>
                          )}
                        </span>
                      ) : <span className="wc-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {unread > 0 && <p className="wc-publish__sub" data-testid="summary-unread">…and {unread} more item{unread === 1 ? "" : "s"} named by this request that are not listed here.</p>}
        {!siteBase && rows.length > 0 && <p className="wc-publish__sub">Open links need the Web Dev department, which could not be found for this company.</p>}
      </Card>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ font: "500 11px var(--font-body)", color: "var(--ink-subtle)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ font: "400 14px var(--font-body)", marginTop: 2 }}>{children}</div>
    </div>
  );
}
