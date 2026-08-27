import { Card, Eyebrow } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { DegradeBanner } from "./DegradeBanner";
import { isBehindLatest, type ContractPinStatus } from "@/lib/webdesk";

/** design §08 v1.1: "a locale-coverage row ('id-ID complete · en-US 3 of 5 pages') — the status an
 *  account manager actually asks for." WSK-23's own report on §24 is explicit that no locale data
 *  reaches Zone A over the bridge today — no fact kind in `webdev_zoneb_event_log`'s CHECK-enumerated
 *  vocabulary carries it, and there is no live Zone B endpoint for it either. Rendering a number here
 *  would be fabricating exactly the kind of confident-wrong-answer this whole tab exists to refuse
 *  to do, so this row states the gap instead of a fake coverage figure. */
function LocaleCoverageRow() {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", paddingTop: 10, marginTop: 10, borderTop: "0.5px solid var(--erp-hairline)" }}>
      <Eyebrow style={{ fontSize: 10, opacity: 0.6, whiteSpace: "nowrap" }}>Locale coverage</Eyebrow>
      <span style={{ font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-50)", fontStyle: "italic" }}>
        Not available — WebDesk doesn&apos;t send locale/localization data to the ERP yet (WSK-D18 needs
        a new bridge fact kind or a live Zone B read; neither exists today).
      </span>
    </div>
  );
}

export function ContractCard({ pin, pinsAvailable }: { pin: ContractPinStatus | null; pinsAvailable: boolean }) {
  if (!pinsAvailable) {
    return (
      <Card title="Contract">
        <p style={{ font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-50)" }}>
          Contract pin status couldn&apos;t be read for this site.
        </p>
      </Card>
    );
  }

  if (!pin) {
    return (
      <Card title="Contract">
        <p style={{ font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-50)" }}>No contract pin on file for this site yet.</p>
        <LocaleCoverageRow />
      </Card>
    );
  }

  const behind = isBehindLatest(pin);

  return (
    <Card title="Contract">
      <DegradeBanner meta={pin.latest} subject="the latest published contract version" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Pinned</Eyebrow>
          <div style={{ font: "600 15px var(--font-body)" }}>
            {pin.pinned ? `contract@${pin.pinned.contractVersion}` : "Unpinned"}
          </div>
          {pin.pinned && (
            <div style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
              vocabulary {pin.pinned.vocabularyVersion} · fetched {formatDateTime(pin.pinned.fetchedAt)}
            </div>
          )}
        </div>
        <div>
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Latest published</Eyebrow>
          <div style={{ font: "600 15px var(--font-body)" }}>
            {pin.latest.version ? `contract@${pin.latest.version}` : "Unknown"}
          </div>
          {pin.latest.vocabularyVersion && (
            <div style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>vocabulary {pin.latest.vocabularyVersion}</div>
          )}
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        {behind === null ? (
          <span style={{ font: "600 13px var(--font-body)", color: "var(--erp-ink-50)" }}>Can&apos;t tell whether this site is behind the latest contract.</span>
        ) : behind ? (
          <span style={{ font: "600 13px var(--font-body)", color: "var(--status-critical-fg)" }}>
            Pinned older than latest — {pin.pinned!.contractVersion} vs {pin.latest.version}.
          </span>
        ) : (
          <span style={{ font: "600 13px var(--font-body)", color: "var(--status-ok-fg)" }}>Pinned to the latest published contract.</span>
        )}
      </div>
      <LocaleCoverageRow />
    </Card>
  );
}
