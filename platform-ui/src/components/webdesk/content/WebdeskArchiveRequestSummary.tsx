import { Card } from "@/components/ui";
import { ARCHIVE_SITE_COPY, parseSiteArchiveArgs } from "@/lib/webdeskContentModel";
import "./content.css";

// The approvals detail page's renderer for a WebDesk site.archive row (owner ruling 2026-10-12: archiving a site takes an approval).
// `WebdeskPublishSummary` was built for publish items and says nothing true about an archive, and `WebdeskKeyRequestSummary` is for a key,
// so an archive row gets its own: WHICH site, what approving does, and that it cannot be undone. `tool_args` is unknown JSON until
// `parseSiteArchiveArgs` says otherwise: a payload that does not match renders as "unrecognised", never as a confident summary of a guess.
// The site's display name is not in `tool_args`; the page reads it from the site list (cosmetic, like the key summary) and the id is the fallback.

export function WebdeskArchiveRequestSummary({ toolArgs, siteName }: {
  toolArgs: unknown;
  /** The site's display name from the site read (cosmetic); the id is shown when it could not be read. */
  siteName: string | null;
}) {
  const args = parseSiteArchiveArgs(toolArgs);
  if (!args) {
    return (
      <Card title="Site archive request">
        <p className="wc-muted" data-testid="archive-summary-unrecognised" style={{ margin: 0 }}>
          Unrecognised request: its arguments are not in the format a site archive request has, so nothing is summarised here. Do not approve it unless you know what it is.
        </p>
      </Card>
    );
  }
  return (
    <Card title="Site archive request">
      <dl className="wc-key-once__facts" data-testid="archive-summary">
        <div><dt>Tenant</dt><dd data-testid="archive-summary-tenant">{args.tenantSlug}</dd></div>
        <div><dt>Site</dt><dd data-testid="archive-summary-site">{siteName ?? args.siteId}{siteName && <span className="wc-muted"> · {args.siteId}</span>}</dd></div>
      </dl>
      <p style={{ margin: "10px 0 0", font: "600 13px var(--font-body)" }} data-testid="archive-summary-irreversible">
        This cannot be undone. WebDesk has no way to un-archive a site.
      </p>
      <p className="wc-muted" style={{ margin: "6px 0 0" }}>Approving archives the site now:</p>
      <ul className="wc-muted" style={{ margin: "4px 0 0", paddingLeft: 18 }} data-testid="archive-summary-effects">
        {ARCHIVE_SITE_COPY.consequences.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </Card>
  );
}
