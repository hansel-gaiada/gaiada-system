"use client";
// SCP-2e and 2f, the staff half (BFF §63.6.2 `clientDecision`, §63.9 "The way in"; plan §8 rows 2e and 2f): two small pieces of the post page.
//
// `ClientDecisionLine` says how the client's latest decision reached us: in the portal, by which of the client's contacts, or recorded by a member of staff on
// the client's behalf, with the channel (WhatsApp, email, a meeting). The decision itself (approved, or the change and its note) is already on the page in the
// status chip and the change banner, so this line only carries who and how.
//
// `ClientLink` is the link we send while the post waits on the client (SCP-Q8: portal login, no no-login link). It opens the post on the portal's approval page
// (`/portal/social?post=<id>`), through the portal sign-in, and can be copied or shared to WhatsApp. It is shown only while the post is with the client.
import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/format";
import type { ClientDecision } from "@/lib/socialPipeline";

const CHANNEL: Record<string, string> = { whatsapp: "WhatsApp", email: "email", meeting: "a meeting" };

export function clientDecisionText(d: ClientDecision): string {
  const what = d.kind === "approved" ? "approved" : `asked for a ${d.changeKind === "design" ? "design" : "copy"} change`;
  const when = d.decidedAt ? `, ${formatDateTime(d.decidedAt)}` : "";
  if (d.via === "recorded") {
    const channel = d.channel ? ` (${CHANNEL[d.channel] ?? d.channel})` : "";
    const by = d.recordedBy ? `${d.recordedBy.name} recorded it` : "Recorded";
    return `The client ${what} outside the portal${channel}. ${by} on the client's behalf${when}.`;
  }
  return `The client ${what} in the portal${d.decidedBy ? `: ${d.decidedBy.name}` : ""}${when}.`;
}

export function ClientDecisionLine({ decision }: { decision: ClientDecision | null }) {
  if (!decision) return null;
  return <p className="scp-post__banner" data-testid="scp-client-decision">{clientDecisionText(decision)}</p>;
}

export const clientLinkPath = (postId: string) => `/portal/social?post=${encodeURIComponent(postId)}`;

export function whatsappShareHref(url: string, title: string): string {
  const text = `A post is ready for your approval${title ? `: ${title}` : ""}. ${url}`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export function ClientLink({ postId, title }: { postId: string; title: string }) {
  const path = clientLinkPath(postId);
  // The absolute address needs the browser's origin; the first render (also on the server) shows the path.
  const [url, setUrl] = useState(path);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  useEffect(() => { setUrl(`${window.location.origin}${path}`); }, [path]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="scp-post__banner" data-testid="scp-client-link">
      <strong>The client&rsquo;s link.</strong> It opens this post on the portal&rsquo;s approval page, after the client signs in.
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2, 8px)", alignItems: "center", marginTop: "var(--space-2, 8px)" }}>
        <input className="scp-input scp-input--wide" type="text" readOnly value={url} aria-label="The client's link" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="scp-link" onClick={copy}>Copy link</button>
        <a className="scp-link" href={whatsappShareHref(url, title)} target="_blank" rel="noopener noreferrer">Share on WhatsApp</a>
      </div>
      {copied && (
        <span role="status">{copied === "ok" ? "Link copied." : "Could not copy. Select the link and copy it by hand."}</span>
      )}
    </div>
  );
}
