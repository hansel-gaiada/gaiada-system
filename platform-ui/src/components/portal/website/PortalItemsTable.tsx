"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { portalPublishItemAction, portalRequestPublishAction } from "@/lib/portalWebsiteActions";
import {
  canOfferPublishNow, hasUnpublishedChanges, itemListState, PORTAL_COPY, PUBLISHED_COPY,
} from "@/lib/portalWebsiteModel";
import { clientRefusal } from "@/lib/webdeskClientCopy";
import { authorLabel, describeReasonToken, type FieldDef, type ItemSummary } from "@/lib/webdeskContentModel";
import { formatDateTime } from "@/lib/format";
import type { SiteScope } from "@/lib/webdeskContentActions";
import { ConfirmAction } from "./ConfirmAction";
import "@/components/webdesk/content/content.css";
import "./website.css";

// The item list of one collection, in the client's words: each item's state (live · live with changes not published · draft ·
// waiting for approval), and the two ways to publish (WSK-D58):
//   • "Publish now" on an item the VIEWER changed: ONE item, goes live immediately (asks once);
//   • select several items, then "Request publish": files ONE request that ANOTHER person from the company approves.
// Nothing here deletes, unpublishes or schedules: the client BFF has no route for any of those, so there is no control for them.
type Notice = { tone: "ok" | "warn" | "bad" | "info"; text: string };

export function PortalItemsTable({
  clientId, scope, editorBase, items, pendingIds, viewerId, authors, labelOf, defs,
}: {
  clientId: string;
  scope: SiteScope;
  /** `…/<tenant>/<site>/<collection>`: item links are `${editorBase}/${slug}?locale=` */
  editorBase: string;
  items: ItemSummary[];
  /** Item ids named by a PENDING publish request of this client. */
  pendingIds: string[];
  viewerId: string;
  authors: Record<string, string>;
  /** Display title per item id (the composition's title field, else the slug), computed on the server. */
  labelOf: Record<string, string>;
  /** The collection's fields, so a refusal can name a field by its label ("Template") rather than its key. */
  defs?: FieldDef[];
}) {
  const router = useRouter();
  const pending = useMemo(() => new Set(pendingIds), [pendingIds]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<null | "request" | string>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const selectable = (it: ItemSummary) => hasUnpublishedChanges(it) && !pending.has(it.itemId);
  const title = (it: ItemSummary) => labelOf[it.itemId] ?? it.slug;
  const chosen = items.filter((it) => selected.includes(it.itemId) && selectable(it));

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const requestPublish = async () => {
    if (chosen.length === 0) return;
    setBusy("request"); setNotice(null);
    const r = await portalRequestPublishAction(clientId, scope, chosen.map((it) => ({ itemId: it.itemId, version: it.headVersion })));
    if (!mounted.current) return;
    setBusy(null);
    if (r.kind !== "ok") {
      const f = clientRefusal(r, "request", { defs, itemLabels: chosen.map(title) });
      setNotice({ tone: f.tone, text: f.text });
      return;
    }
    setSelected([]);
    setNotice({ tone: "ok", text: PORTAL_COPY.requestFiled(r.data.itemCount) });
    router.refresh();
  };

  const publishNow = async (it: ItemSummary) => {
    setBusy(it.itemId); setNotice(null);
    const r = await portalPublishItemAction(clientId, scope, it.itemId, it.headVersion);
    if (!mounted.current) return;
    setBusy(null);
    if (r.kind !== "ok") {
      const f = clientRefusal(r, "publish", { defs, itemLabels: [title(it)] });
      setNotice({ tone: f.tone, text: f.text });
      return;
    }
    if (r.data.executionStatus === "failed") {
      setNotice({ tone: "bad", text: `Publishing ${title(it)} didn't complete. ${describeReasonToken(r.data.error)} You can try again.` });
      router.refresh();
      return;
    }
    setNotice({ tone: "ok", text: `${title(it)}: ${PUBLISHED_COPY}` });
    router.refresh();
  };

  return (
    <div className="wc-page">
      <div className="wc-publish__actions" data-testid="batch-bar">
        <button
          type="button" className="lux-btn lux-btn--solid lux-btn--sm" data-testid="request-publish"
          disabled={chosen.length === 0 || busy !== null} aria-describedby="portal-batch-help"
          onClick={() => void requestPublish()}
        >
          {busy === "request" ? "Filing…" : `Request publish${chosen.length > 0 ? ` (${chosen.length})` : ""}`}
        </button>
        <span id="portal-batch-help" className="wc-muted">
          {chosen.length === 0
            ? "Select pages with changes to publish them together. Another person from your company approves the request."
            : `${chosen.length} page${chosen.length === 1 ? "" : "s"} selected. Another person from your company approves the request before anything goes live.`}
        </span>
      </div>

      <div role="status" aria-live="polite" data-testid="items-notice">
        {notice && <div className={`wc-banner wc-banner--${notice.tone}`}><span className="wc-banner__body">{notice.text}</span></div>}
      </div>

      <div className="wc-scroll pw-links">
        <table className="wc-table" data-testid="items-table">
          <caption className="wc-sr">Pages in this collection, with their state and publishing actions</caption>
          <thead>
            <tr>
              <th scope="col"><span className="wc-sr">Select for a publish request</span></th>
              <th scope="col">Page</th><th scope="col">Language</th><th scope="col">State</th><th scope="col">Last changed</th><th scope="col">Publish</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const st = itemListState(it, pending, it.itemId);
              const canSelect = selectable(it);
              const name = title(it);
              return (
                <tr key={it.itemId} data-testid={`item-row-${it.slug}`} data-locale={it.locale} data-state={st.key}>
                  <td>
                    <input
                      type="checkbox" checked={selected.includes(it.itemId) && canSelect} disabled={!canSelect || busy !== null}
                      aria-label={`Select ${name} (${it.locale}) for a publish request`}
                      title={!canSelect ? (st.pendingRequest ? "Already in a publish request" : "Nothing new to publish") : undefined}
                      onChange={() => toggle(it.itemId)}
                    />
                  </td>
                  <td><Link href={`${editorBase}/${encodeURIComponent(it.slug)}?locale=${encodeURIComponent(it.locale)}`}>{name}</Link></td>
                  <td>{it.locale}</td>
                  <td>
                    <span className={`wc-chip${st.tone ? ` wc-chip--${st.tone}` : ""}`}>{st.label}</span>
                    {st.pendingRequest && <> <span className="wc-chip wc-chip--info">Waiting for approval</span></>}
                  </td>
                  <td title={`Last changed ${formatDateTime(it.headCreatedAt)}`}>{formatDateTime(it.updatedAt)} <span className="wc-muted">by {authorLabel(it.headCreatedBy, authors)}</span></td>
                  <td>
                    {canOfferPublishNow(it, viewerId) && !st.pendingRequest ? (
                      <ConfirmAction
                        label="Publish now" ariaLabel={`Publish ${name} now`} testId={`publish-now-${it.slug}`}
                        question={`Publish v${it.headVersion} of ${name} now? It goes live on your site.`} confirmLabel="Publish now"
                        busy={busy === it.itemId} disabled={busy !== null && busy !== it.itemId}
                        onConfirm={() => publishNow(it)} variant="ghost"
                      />
                    ) : <span className="wc-muted">{hasUnpublishedChanges(it) ? (st.pendingRequest ? "In a request" : "Add to a request") : "Nothing new"}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
