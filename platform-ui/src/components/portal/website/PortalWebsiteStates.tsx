import Link from "next/link";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { NO_WEBSITE_ACCESS_COPY } from "@/lib/portalWebsiteAccess";
import { clientRefusal } from "@/lib/webdeskClientCopy";
import type { WdResult } from "@/lib/webdeskContentModel";
import "@/components/webdesk/content/content.css";

// The two page-level states of the portal's Website area, in the client's words.
//
//   <NoWebsiteAccess />        the viewer holds no website-editor grant for the active client (or has no client account here).
//                              A plain page, never a confident empty list: the same words whether the viewer is staff, a client
//                              contact without the grant, or someone who typed the URL.
//   <PortalWebsiteRefusal />   a read that did not return data. The page returns it BEFORE it touches anything that could draw a
//                              list or a form, so "the website service is down" can never read as "you have no pages".

export function NoWebsiteAccess() {
  return (
    <>
      <PortalPageHead eyebrow="Your website" title="Website" />
      <div className="wc-notice" role="note" data-testid="no-website-access">
        <h2>{NO_WEBSITE_ACCESS_COPY}</h2>
      </div>
    </>
  );
}

export function PortalWebsiteRefusal({
  result, subject, retryHref,
}: {
  result: Exclude<WdResult<unknown>, { kind: "ok" }>;
  /** What could not be read, in the page's words: "your website", "this page". */
  subject: string;
  retryHref?: string;
}) {
  if (result.kind === "forbidden") return <NoWebsiteAccess />;
  const f = clientRefusal(result, "read");
  const retry = retryHref && (result.kind === "unavailable") ? (
    <div className="wc-notice__actions"><Link href={retryHref} className="lux-btn lux-btn--ghost lux-btn--sm">Try again</Link></div>
  ) : null;
  if (result.kind === "unavailable") {
    const drift = result.code === "contract_drift";
    return (
      <div className={`wc-notice${drift ? " wc-notice--bad" : ""}`} role="alert" data-testid={drift ? "website-drift" : "website-unavailable"}>
        <h2>{drift ? `We couldn't show ${subject}` : "Editing is unavailable right now"}</h2>
        <p>
          {drift
            ? "The website service answered with something we didn't expect, so nothing is shown rather than a wrong answer. This does not mean there is nothing here. Please tell Gaiada."
            : "The website service can't be reached. Nothing has been lost."}
        </p>
        {retry}
      </div>
    );
  }
  return (
    <div className="wc-notice" role="note" data-testid={`website-${result.kind}`}>
      <h2>{f.text}</h2>
    </div>
  );
}
