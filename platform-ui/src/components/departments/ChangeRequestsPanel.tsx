"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { Card, HairlineTable, StatusBadge, Button } from "@/components/ui";
import { TeachState } from "./TeachState";
import {
  KIND_LABEL, ROUTE_LABEL, ROUTES, STATUS_LABEL, sortQueue, suggestedRoute, linkedArtifactHref,
  type ChangeRequestDetail, type ChangeRequestRow, type CrKind, type CrRoute, type ExistingTriageArtifact,
} from "@/lib/webdevChangeRequests";
import { formatDateTime } from "@/lib/format";

type DetailResult = { ok: true; row: ChangeRequestDetail } | { ok: false; error: string };
type TriageResult =
  | { ok: true; status: string; route: CrRoute | null; pipelineRunId?: string; pmTaskId?: string }
  | { ok: false; error: string; existing?: ExistingTriageArtifact; notImplemented?: boolean };

export interface ChangeRequestsPanelActions {
  getDetail: (id: string) => Promise<DetailResult>;
  triage: (id: string, payload: { action: "decline" | "convert"; route?: CrRoute; reason?: string; kindOverride?: CrKind }) => Promise<TriageResult>;
}

/** The outcome banner shown after a triage POST resolves — success, the 409 "already triaged" race
 *  (NOT an error state: §2.2/MI-05's instruction is to show the existing artifact, not a toast), or
 *  the 501 control_plane refusal (the CR stays re-triageable, so this is informational too). */
function OutcomeBanner({ outcome }: { outcome: TriageResult }) {
  if (outcome.ok) {
    return (
      <p className="dept-teach__body" role="status" style={{ color: "var(--status-ok-fg)" }}>
        {outcome.status === "declined" ? "Declined." : `Converted — now ${STATUS_LABEL[outcome.status as keyof typeof STATUS_LABEL] ?? outcome.status}.`}
      </p>
    );
  }
  if (outcome.existing) {
    // Someone else's convert/decline won the race. Point at what already exists rather than
    // reporting failure — a double-click is expected here, not exceptional.
    const href = linkedArtifactHref({ route: outcome.existing.route, pipelineRunId: outcome.existing.pipelineRunId, pmTaskId: outcome.existing.pmTaskId });
    return (
      <p className="dept-teach__body" role="status">
        Already triaged (now {STATUS_LABEL[outcome.existing.status]}).{" "}
        {href ? <Link href={href}>Open the existing {outcome.existing.route === "mini_run" ? "run" : "task"} →</Link> : null}
      </p>
    );
  }
  if (outcome.notImplemented) {
    return <p className="dept-teach__body" role="alert" style={{ color: "var(--status-critical-fg)" }}>{outcome.error}</p>;
  }
  return <p className="dept-teach__body" role="alert" style={{ color: "var(--status-critical-fg)" }}>{outcome.error}</p>;
}

function TriageDrawer({
  row, detail, canTriage, actions, onDisposed,
}: {
  row: ChangeRequestRow;
  detail: ChangeRequestDetail | null;
  canTriage: boolean;
  actions: ChangeRequestsPanelActions;
  onDisposed: () => void;
}) {
  const [reason, setReason] = useState("");
  const [kindOverride, setKindOverride] = useState<CrKind>(row.kind);
  const [route, setRoute] = useState<CrRoute>(suggestedRoute(row.kind));
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<TriageResult | null>(null);

  const canDispose = canTriage && row.status === "new";
  const artifactHref = linkedArtifactHref(row);

  const decline = () => {
    if (!reason.trim()) { setOutcome({ ok: false, error: "A decline needs a reason — the requester sees it." }); return; }
    setOutcome(null);
    startTransition(async () => {
      const r = await actions.triage(row.id, { action: "decline", reason: reason.trim(), kindOverride });
      setOutcome(r);
      if (r.ok || r.existing) onDisposed();
    });
  };

  const convert = () => {
    setOutcome(null);
    startTransition(async () => {
      const r = await actions.triage(row.id, { action: "convert", route, kindOverride });
      setOutcome(r);
      if (r.ok || r.existing) onDisposed();
    });
  };

  return (
    <Card
      title={row.title}
      headerRight={<StatusBadge label={row.status} />}
    >
      <div className="dept-teach" style={{ alignItems: "flex-start", textAlign: "left" }}>
        <p className="dept-teach__body"><strong>Kind:</strong> {KIND_LABEL[row.kind]}</p>
        <p className="dept-teach__body"><strong>Client:</strong> {row.clientName ?? "—"}{row.projectName ? ` / ${row.projectName}` : ""}</p>
        <p className="dept-teach__body"><strong>Requested by:</strong> {row.requestedByName ?? row.requestedBy ?? "—"} ({row.source})</p>
        {detail?.body && <p className="dept-teach__body">{detail.body}</p>}
        {row.status === "declined" && row.declinedReason && (
          <p className="dept-teach__body"><strong>Declined:</strong> {row.declinedReason}</p>
        )}
        {artifactHref && (
          <p className="dept-teach__body">
            <strong>Linked {row.route === "mini_run" ? "run" : "task"}:</strong>{" "}
            <Link href={artifactHref}>
              {row.route === "mini_run" ? (detail?.runTitle ?? row.pipelineRunId) : (detail?.taskTitle ?? row.pmTaskId)}
              {" "}({row.route === "mini_run" ? (detail?.runStatus ?? "—") : (detail?.taskStatus ?? "—")}) →
            </Link>
          </p>
        )}
      </div>

      {canDispose && (
        <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="type-eyebrow" style={{ fontSize: 10, opacity: 0.6 }}>Kind (override)</span>
            <select value={kindOverride} onChange={(e) => setKindOverride(e.target.value as CrKind)} disabled={pending}>
              {(Object.keys(KIND_LABEL) as CrKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </label>

          <label style={{ display: "grid", gap: 4 }}>
            {/* §2.3: the default is a SUGGESTION, not a forced value — the select is fully editable,
                pre-filled from suggestedRoute(kindOverride) only on the initial render. */}
            <span className="type-eyebrow" style={{ fontSize: 10, opacity: 0.6 }}>Route (suggested: {ROUTE_LABEL[suggestedRoute(kindOverride)]})</span>
            <select value={route} onChange={(e) => setRoute(e.target.value as CrRoute)} disabled={pending}>
              {ROUTES.map((r) => <option key={r} value={r}>{ROUTE_LABEL[r]}</option>)}
            </select>
          </label>
          <Button onClick={convert} disabled={pending}>{pending ? "Working…" : "Convert"}</Button>

          <label style={{ display: "grid", gap: 4 }}>
            <span className="type-eyebrow" style={{ fontSize: 10, opacity: 0.6 }}>Decline reason</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending} rows={2} />
          </label>
          <Button variant="ghost" onClick={decline} disabled={pending}>{pending ? "Working…" : "Decline"}</Button>
        </div>
      )}

      {outcome && <OutcomeBanner outcome={outcome} />}
    </Card>
  );
}

export function ChangeRequestsPanel({ rows, canTriage, actions }: { rows: ChangeRequestRow[]; canTriage: boolean; actions: ChangeRequestsPanelActions }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ChangeRequestDetail | null>(null);
  const [, startTransition] = useTransition();
  const [refreshKey, setRefreshKey] = useState(0);

  if (rows.length === 0) {
    return (
      <TeachState
        glyph="✦"
        title="No maintenance requests yet"
        body="Client-submitted (and internally logged) change requests will queue here for triage — decline, or convert into a mini pipeline run or a PM task."
      />
    );
  }

  const queue = sortQueue(rows);
  const selected = queue.find((r) => r.id === selectedId) ?? null;

  const select = (id: string) => {
    setSelectedId(id);
    setDetail(null);
    startTransition(async () => {
      const r = await actions.getDetail(id);
      if (r.ok) setDetail(r.row);
    });
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: selected ? "1.4fr 1fr" : "1fr", gap: 24, alignItems: "start" }}>
      <Card title="Triage queue">
        <HairlineTable
          key={refreshKey}
          columns={[{ label: "Request" }, { label: "Kind" }, { label: "Client" }, { label: "Status" }, { label: "Submitted", align: "right" }]}
          tcols="2fr 0.8fr 1.2fr 1fr 1fr"
          rows={queue.map((r) => [
            <button key="t" type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => select(r.id)} style={{ padding: 0, font: "inherit", textAlign: "left" }}>
              {r.title}
            </button>,
            KIND_LABEL[r.kind],
            r.clientName ?? "—",
            <StatusBadge key="s" label={r.status} />,
            formatDateTime(r.createdAt),
          ])}
        />
      </Card>

      {selected && (
        <TriageDrawer
          key={selected.id}
          row={selected}
          detail={detail}
          canTriage={canTriage}
          actions={actions}
          onDisposed={() => setRefreshKey((k) => k + 1)}
        />
      )}
    </div>
  );
}
