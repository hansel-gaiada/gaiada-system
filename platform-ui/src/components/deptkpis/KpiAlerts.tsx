import type { KpiAlertsResult } from "@/lib/deptKpiAlerts";
import {
  acknowledgedLine, alertReading, alertState, newestFirst, offTrackSince, resolvedLine, tileAlertLine, type KpiAlert,
} from "@/lib/deptKpiAlertFormat";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { AcknowledgeAlert } from "./AcknowledgeAlert";
import "./deptKpis.css";

// DW-4j-2 — the KPI page's two views of the alerts (BFF §43.7): the line on a KPI tile that has an OPEN alert, and the unit's alert
// history below the tiles. Presentational: the page reads the alerts (`getUnitKpiAlerts`, an honest reader) and passes the result in.
// The status colour is the existing `dk-badge` tone, and the state is always also said in words.

/** "Off track since 3 Oct · acknowledged by Ayu": the line under a tile whose KPI has an open alert. */
export function TileAlertLine({ alert, refYear }: { alert: KpiAlert; refYear?: number }) {
  return <span className="dk-tile__foot dk-tile__alert">{tileAlertLine(alert, refYear)}</span>;
}

const STATE_WORD = { open: "Open", acknowledged: "Open, acknowledged", resolved: "Resolved" } as const;

function stateTone(a: KpiAlert): "danger" | "warning" | "ok" | "idle" {
  if (a.resolvedAt) return a.resolvedCondition === "on_track" ? "ok" : "idle";
  return a.acknowledgedAt ? "warning" : "danger";
}

function AlertRow({ alert, tenantId, canAcknowledge, refYear }: { alert: KpiAlert; tenantId: string; canAcknowledge: boolean; refYear?: number }) {
  const state = alertState(alert);
  const tone = stateTone(alert);
  const reading = alertReading(alert);
  const ack = acknowledgedLine(alert, refYear);
  const resolved = resolvedLine(alert, refYear);
  return (
    <li className="dk-alert">
      <div className="dk-alert__head">
        <h4 className="dk-target__name">{alert.kpiLabel}</h4>
        <span className={`dk-badge dk-badge--${tone}`}>{STATE_WORD[state]}</span>
      </div>
      <p className="dk-target__meta">
        {offTrackSince(alert, refYear)}
        {reading ? ` · ${reading}` : ""}
      </p>
      {ack && (
        <p className="dk-target__meta">
          {ack}
          {alert.ackNote ? <>. Note: <span className="dk-alert__note">{alert.ackNote}</span></> : null}
        </p>
      )}
      {resolved && <p className="dk-target__meta">{resolved}</p>}
      {state === "open" && canAcknowledge && <AcknowledgeAlert tenantId={tenantId} alertId={alert.id} kpiLabel={alert.kpiLabel} />}
    </li>
  );
}

/**
 * The unit's alert history, newest first. Four honest states: the list; "No alerts yet" for a read that succeeded with nothing in it
 * (a TRUE statement); the quiet nothing for a refusal (the page's own gate already speaks); and "could not be loaded" for a failed
 * read, never an empty claim. `canAcknowledge` mirrors "head of this unit, or company-wide": it only decides whether the button is
 * offered, the server decides whether the acknowledgement is allowed.
 */
export function AlertsSection({ result, tenantId, canAcknowledge, refYear }: { result: KpiAlertsResult; tenantId: string; canAcknowledge: boolean; refYear?: number }) {
  if (result.kind === "forbidden") return null;
  return (
    <Card title="Alerts" hint="An alert opens when a KPI goes off track and stays open until the daily check finds it is no longer off track. A head acknowledges it to say they have seen it. Acknowledging does not change the KPI.">
      {result.kind === "ok" ? (
        result.data.length === 0 ? (
          <EmptyNote>No alerts yet</EmptyNote>
        ) : (
          <ul className="dk-alerts" aria-label="Alerts">
            {newestFirst(result.data).map((a) => (
              <AlertRow key={a.id} alert={a} tenantId={tenantId} canAcknowledge={canAcknowledge} refYear={refYear} />
            ))}
          </ul>
        )
      ) : (
        <ReadRefusal
          inline
          subject="This department's alerts"
          kind="unavailable"
          detail="The alerts could not be loaded."
          reason={result.kind === "error" ? result.reason : "The department was not found."}
        />
      )}
    </Card>
  );
}
