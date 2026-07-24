"use client";
import { useActionState, useCallback, useEffect, useState } from "react";
import { Card, Button, StatusBadge, Toast, Eyebrow } from "@/components/ui";
import { EmptyNote } from "./EmptyNote";
import "./systems.css";

// Ported from aire's WahaConnect UX (apps/frontend/src/app/dashboard/ai-agent/page.tsx)
// onto this repo's design system, and re-targeted at the frozen nest contract
// (doc §2.4 `api/admin/bot/session/*`, §2.5 UI spec). Server actions are
// passed in as props — bound already by the page — mirroring how
// ConfigField/ReviewButtons receive their actions.

export interface BotSessionActionState {
  ok: boolean;
  error?: string;
}
type SessionAction = (prev: BotSessionActionState | null, formData: FormData) => Promise<BotSessionActionState>;

interface BotSessionInfo {
  session: string;
  status: string;
  engine?: string;
  me?: { id: string; pushName?: string } | null;
  lastEvent?: { status: string; ts: number } | null;
}
interface BotSessionPoll {
  status: BotSessionInfo | null;
  qr: string | null;
  error?: string;
}

// Poll state machine (doc §2.5): fetch once on mount, then poll every 3s
// ONLY while status is mid-pairing. The moment status flips to
// WORKING/FAILED/STOPPED/anything else, the interval effect's own cleanup
// fires and no new one is scheduled — polling self-terminates, it is never
// stopped by an explicit branch elsewhere.
const PAIRING_STATUSES = new Set(["STARTING", "SCAN_QR_CODE"]);
const POLL_INTERVAL_MS = 3000;
const TRAIL_LIMIT = 10;

export function WhatsAppConnect({
  elevated,
  startAction,
  stopAction,
  restartAction,
  logoutAction,
}: {
  elevated: boolean;
  startAction: SessionAction;
  stopAction: SessionAction;
  restartAction: SessionAction;
  logoutAction: SessionAction;
}) {
  const [poll, setPoll] = useState<BotSessionPoll | null>(null);
  const [trail, setTrail] = useState<{ status: string; ts: number }[]>([]);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const [startState, startFormAction, startPending] = useActionState(startAction, null);
  const [stopState, stopFormAction, stopPending] = useActionState(stopAction, null);
  const [restartState, restartFormAction, restartPending] = useActionState(restartAction, null);
  const [logoutState, logoutFormAction, logoutPending] = useActionState(logoutAction, null);

  const fetchPoll = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/bot/session", { cache: "no-store" });
      const body = (await res.json()) as BotSessionPoll;
      setPoll(body);
      const ev = body.status?.lastEvent;
      if (ev) {
        setTrail((prev) =>
          prev[0]?.ts === ev.ts && prev[0]?.status === ev.status ? prev : [ev, ...prev].slice(0, TRAIL_LIMIT),
        );
      }
    } catch {
      setPoll({ status: null, qr: null, error: "Could not reach the bot admin proxy." });
    }
  }, []);

  // Initial load.
  useEffect(() => {
    if (!elevated) return;
    fetchPoll();
  }, [elevated, fetchPoll]);

  // Re-poll immediately whenever a mutation completes, so Start/Restart/Stop/
  // Logout reflect the new status right away instead of waiting up to 3s.
  useEffect(() => {
    if (!elevated) return;
    if (startState || stopState || restartState || logoutState) fetchPoll();
  }, [elevated, startState, stopState, restartState, logoutState, fetchPoll]);

  // The 3s interval itself — armed only while status is mid-pairing.
  useEffect(() => {
    if (!elevated) return;
    const s = poll?.status?.status;
    if (!s || !PAIRING_STATUSES.has(s)) return;
    const id = setInterval(fetchPoll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [elevated, poll?.status?.status, fetchPoll]);

  if (!elevated) {
    return (
      <Card title="Connect WhatsApp">
        <EmptyNote>WhatsApp connection controls are limited to superadmins/owners.</EmptyNote>
      </Card>
    );
  }

  const info = poll?.status ?? null;
  const statusValue = info?.status ?? null;
  const qr = poll?.qr ?? null;
  const showQr = qr != null && statusValue != null && PAIRING_STATUSES.has(statusValue);
  const pairedNumber = info?.me?.pushName ?? info?.me?.id ?? null;

  return (
    <Card title="Connect WhatsApp">
      <div className="sys-status-card__head">
        <StatusBadge label={statusValue ?? "unknown"} />
        {info?.engine && <span className="sys-status-card__version">{info.engine}</span>}
        {statusValue === "WORKING" && pairedNumber && (
          <span className="sys-status-card__uptime">Paired: {pairedNumber}</span>
        )}
      </div>

      {poll?.error && <Toast message={poll.error} />}
      {statusValue === "FAILED" && <Toast message="Connection failed — try Restart." />}

      {showQr && (
        <div style={{ textAlign: "center", marginTop: 16 }}>
          <p style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-50)", marginBottom: 8 }}>
            Scan with WhatsApp on the connected phone.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element -- a base64 data: URL, next/image cannot optimize it and shouldn't try. */}
          <img src={qr} alt="WhatsApp pairing QR code" width={240} height={240} style={{ borderRadius: 4 }} />
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16, alignItems: "center" }}>
        <form action={startFormAction}>
          <Button type="submit" disabled={startPending}>
            {startPending ? "Connecting…" : "Connect / Get QR"}
          </Button>
        </form>
        <form action={restartFormAction}>
          <Button type="submit" variant="ghost" disabled={restartPending}>
            {restartPending ? "Restarting…" : "Restart"}
          </Button>
        </form>
        <form action={stopFormAction}>
          <Button type="submit" variant="ghost" disabled={stopPending}>
            {stopPending ? "Stopping…" : "Stop"}
          </Button>
        </form>

        {!confirmLogout ? (
          <Button type="button" variant="ghost" onClick={() => setConfirmLogout(true)} disabled={logoutPending}>
            Logout
          </Button>
        ) : (
          <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} role="alertdialog" aria-label="Confirm WhatsApp logout">
            <span style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>
              This unpairs the WhatsApp number; you will need to re-scan.
            </span>
            <form action={logoutFormAction} onSubmit={() => setConfirmLogout(false)}>
              <Button type="submit" disabled={logoutPending}>
                {logoutPending ? "Logging out…" : "Yes, log out"}
              </Button>
            </form>
            <Button type="button" variant="ghost" onClick={() => setConfirmLogout(false)}>
              Cancel
            </Button>
          </span>
        )}
      </div>

      {startState?.error && <Toast message={startState.error} />}
      {stopState?.error && <Toast message={stopState.error} />}
      {restartState?.error && <Toast message={restartState.error} />}
      {logoutState?.error && <Toast message={logoutState.error} />}
      {logoutState?.ok && <Toast message="Logged out — scan a new QR to reconnect." />}

      {trail.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Recent events</Eyebrow>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-50)" }}>
            {trail.map((ev, i) => (
              <li key={`${ev.ts}-${i}`}>
                {ev.status} — {new Date(ev.ts).toLocaleString()}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
