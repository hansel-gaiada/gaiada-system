"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { portalGetItemHeadAction, portalPublishItemAction } from "@/lib/portalWebsiteActions";
import { publishOutcomeCopy, requesterLabel, type PortalBuild, type PortalPublishRequest } from "@/lib/portalWebsiteModel";
import { clientRefusal } from "@/lib/webdeskClientCopy";
import { describeReasonToken, hasPendingChanges, isLive, publishStateLabel, type ItemRef } from "@/lib/webdeskContentModel";
import type { SiteScope } from "@/lib/webdeskContentActions";
import { ConfirmAction } from "./ConfirmAction";
import "@/components/webdesk/content/content.css";

// The publishing panel of the portal's item editor (WSK-D58), in the place the staff editor draws its PublishBar.
//
//   • SELF-PUBLISH ONE item: "Publish now", offered for a change THE VIEWER made. It asks once, then the BFF files the request and
//     approves it as the same person in one call, and the answer says whether it executed.
//   • A BATCH is not filed from here: it needs a second person, so it is built on the collection's list (select pages) and decided
//     in "Publish requests" on the Website page. This panel says so and links to both.
//
// HONESTY RULES (each one is a way to lie by omission):
//   • "Published." is shown only after the item READ confirms `publishedVersion === N` (an approval that says `executed` is not enough,
//     the same rule the staff bar follows). If the read cannot confirm it, the panel says so and says what to do.
//   • A write whose outcome is unknown (502 webdesk_ambiguous) is neither "done" nor "failed": the editor is told (`onUnconfirmed`) and
//     blocks writes until a re-read.
//   • The staging rebuild state the answer carries (WSK-D65) is said in words (`publishOutcomeCopy`): "live on your site" ONLY for
//     `state === "live"`. The panel's own second line says the VERSION is published, never that the site is live.
//   • Nothing here can unpublish, delete or schedule: the client BFF has no route for any of them.
type Outcome =
  | { kind: "published"; version: number; build: PortalBuild | null }
  | { kind: "unconfirmed-live"; version: number }
  | { kind: "failed"; reason: string }
  | { kind: "refused"; tone: "bad" | "warn" | "info"; text: string };

export function PortalPublishPanel({
  clientId, scope, item, version, dirty, blocked, headIsMine, headAuthor, requests, listHref, requestsHref,
  onItemChanged, onUnavailable, onUnconfirmed,
}: {
  clientId: string;
  scope: SiteScope;
  item: ItemRef;
  /** The saved head version a publish would name. */
  version: number;
  dirty: boolean;
  blocked: string | null;
  headIsMine: boolean;
  headAuthor: string | null;
  /** This client's pending requests that name this item (`null` when that lookup failed). */
  requests: PortalPublishRequest[] | null;
  /** The collection's list (where a batch request is built). */
  listHref: string;
  /** The Website page's "Publish requests" section. */
  requestsHref: string;
  onItemChanged: (item: ItemRef) => void;
  onUnavailable: (reason: string) => void;
  onUnconfirmed: (what: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const focusOutcome = useRef(false);
  // A confirmed publish moves focus to the outcome (ConfirmAction does not send it back to the opener, which is disabled afterwards).
  useEffect(() => { if (outcome && focusOutcome.current) { focusOutcome.current = false; flowRef.current?.focus(); } }, [outcome]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const live = isLive(item);
  const pending = hasPendingChanges(item);
  const nothing = item.deletedAt !== null ? "This page is deleted." : !pending ? "There is nothing new to publish." : null;
  const why = blocked ?? (dirty ? "Save your changes before publishing." : nothing)
    ?? (!headIsMine ? `The latest change was made by ${headAuthor ?? "someone else"}. Publish now is for changes you made: add this page to a publish request instead.` : null);
  const mine = requests?.filter((r) => r.status === "pending") ?? [];

  const publish = async () => {
    setBusy(true); setOutcome(null); focusOutcome.current = true;
    let r: Awaited<ReturnType<typeof portalPublishItemAction>>;
    try {
      r = await portalPublishItemAction(clientId, scope, item.itemId, version);
    } catch {
      if (!mounted.current) return;
      setBusy(false);
      setOutcome({ kind: "refused", tone: "bad", text: "Couldn't reach the website service. Nothing was published." });
      return;
    }
    if (!mounted.current) return;
    if (r.kind !== "ok") {
      setBusy(false);
      const f = clientRefusal(r, "publish");
      if (f.unknown) { onUnconfirmed("the publish"); return; }
      if (r.kind === "unavailable" && r.code !== "contract_drift") onUnavailable(r.reason);
      setOutcome({ kind: "refused", tone: f.tone, text: f.text });
      return;
    }
    if (r.data.executionStatus === "failed") {
      setBusy(false);
      setOutcome({ kind: "failed", reason: describeReasonToken(r.data.error) });
      return;
    }
    // It says executed: confirm against the item itself before saying "Published".
    const head = await portalGetItemHeadAction(clientId, scope, item.itemId);
    if (!mounted.current) return;
    setBusy(false);
    if (head.kind === "ok") {
      onItemChanged(head.data.item);
      setOutcome(head.data.item.publishedVersion === version ? { kind: "published", version, build: r.data.build } : { kind: "unconfirmed-live", version });
    } else {
      setOutcome({ kind: "unconfirmed-live", version });
    }
  };

  return (
    <section className="wc-side-card wc-publish" aria-label="Publishing" data-testid="portal-publish">
      <h3>Publishing</h3>
      <p className="wc-publish__line" data-testid="publish-state">
        {item.deletedAt ? "Deleted"
          : live ? `Live · v${item.publishedVersion}`
          : item.publishState === "unpublished" ? "Not live"
          : item.publishState === "scheduled" ? "Scheduled by Gaiada"
          : "Draft · not live yet"}
      </p>
      <p className="wc-publish__sub">
        Latest draft v{item.headVersion} · {publishStateLabel(item.publishState)}
        {live && pending ? " · has changes that are not published" : ""}
      </p>

      {requests === null && <p className="wc-publish__sub" role="note">Couldn&apos;t check whether this page is in a publish request.</p>}
      {mine.length > 0 && (
        <p className="wc-publish__sub" data-testid="in-request">
          This page is in a publish request waiting for approval ({mine.map((r) => `filed by ${requesterLabel(r)}`).join("; ")}). <Link href={requestsHref}>See publish requests</Link>
        </p>
      )}

      <div ref={flowRef} tabIndex={-1} aria-live="polite" data-testid="publish-flow">
        {outcome?.kind === "published" && (() => {
          const o = publishOutcomeCopy(outcome.build);
          return (
            <div className={`wc-banner wc-banner--${o.tone}`} data-testid="published" data-build={outcome.build?.state ?? "none"}>
              <span className="wc-banner__body"><strong data-testid="published-copy">{o.text}</strong><br />Version {outcome.version} is published.</span>
            </div>
          );
        })()}
        {outcome?.kind === "unconfirmed-live" && (
          <div className="wc-banner wc-banner--warn" data-testid="published-unconfirmed">
            <span className="wc-banner__body"><strong>The publish went through, but we can&apos;t yet see v{outcome.version} as live.</strong> It may still be on its way. Reload this page in a minute to check.</span>
          </div>
        )}
        {outcome?.kind === "failed" && (
          <div className="wc-banner wc-banner--bad" data-testid="publish-failed">
            <span className="wc-banner__body"><strong>Publishing didn&apos;t complete.</strong> {outcome.reason} Your draft is unchanged. You can try again.</span>
          </div>
        )}
        {outcome?.kind === "refused" && (
          <div className={`wc-banner wc-banner--${outcome.tone}`} data-testid="publish-refused">
            <span className="wc-banner__body">{outcome.text}</span>
          </div>
        )}
      </div>

      <div className="wc-publish__actions">
        <ConfirmAction
          label="Publish now"
          ariaLabel="Publish this page now"
          question={`Publish v${version} of this page now? It goes live on your site.`}
          confirmLabel="Publish now"
          testId="publish-now"
          busy={busy}
          disabled={why !== null}
          describedBy={why ? "portal-publish-why" : undefined}
          onConfirm={publish}
        />
      </div>
      {why && <p id="portal-publish-why" className="wc-publish__sub" data-testid="publish-block-reason">{why}</p>}
      <p className="wc-publish__sub">
        To publish several pages together, select them on <Link href={listHref}>the list</Link>: another person from your company then approves the request.
      </p>
    </section>
  );
}
