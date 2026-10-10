import { Card } from "@/components/ui";
import { KEY_REQUEST_COPY, parseKeyMintArgs } from "@/lib/webdeskContentModel";
import "./content.css";

// The approvals detail page's renderer for a WebDesk key.mint row. `WebdeskPublishSummary` was built for publish items (items, diffs,
// lint, rebuild target) and says nothing true about a key request, so a key.mint row gets its own summary: WHICH site, WHICH
// environment, WHICH scope, and what approving does. `tool_args` is unknown JSON until `parseKeyMintArgs` says otherwise — a payload
// that does not match renders as "unrecognised", never as a confident summary of a guess.

export function WebdeskKeyRequestSummary({
  toolArgs, siteName, environmentName,
}: {
  toolArgs: unknown;
  /** Names from the site read, when it could be made (cosmetic); the ids are shown otherwise. */
  siteName: string | null;
  environmentName: string | null;
}) {
  const args = parseKeyMintArgs(toolArgs);
  if (!args) {
    return (
      <Card title="API key request">
        <p className="wc-muted" data-testid="key-summary-unrecognised" style={{ margin: 0 }}>
          Unrecognised request: its arguments are not in the format an API key request has, so nothing is summarised here. Do not approve it unless you know what it is.
        </p>
      </Card>
    );
  }
  return (
    <Card title="API key request">
      <dl className="wc-key-once__facts" data-testid="key-summary">
        <div><dt>Site</dt><dd data-testid="key-summary-site">{siteName ?? args.siteId}<span className="wc-muted"> · {args.tenantSlug}</span></dd></div>
        <div><dt>Environment</dt><dd data-testid="key-summary-env">{environmentName ?? args.envId}</dd></div>
        <div><dt>Scope</dt><dd data-testid="key-summary-scope">{args.scope}</dd></div>
      </dl>
      {args.scope === "write" && <p className="wc-muted" style={{ margin: "10px 0 0" }}>{KEY_REQUEST_COPY.writeHint}</p>}
      <p className="wc-muted" style={{ margin: "10px 0 0" }}>
        Approving creates the key and shows it to you once. WebDesk keeps only a fingerprint of it.
      </p>
    </Card>
  );
}
