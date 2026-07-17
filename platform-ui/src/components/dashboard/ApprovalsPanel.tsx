"use client";
import { useState } from "react";
import Link from "next/link";
import type { ApprovalItem } from "@/lib/data";
import { Icon } from "@/components/shell/icons";
import { Toast } from "@/components/ui";
import "./dashboard.css";

type Decide = (tenantId: string, approvalId: string, decision: "approved" | "rejected") => Promise<{ ok: boolean; error?: string }>;

export function ApprovalsPanel({ items, decide }: { items: ApprovalItem[]; decide: Decide }) {
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const visible = items.filter((i) => !gone.has(i.id));

  async function act(item: ApprovalItem, decision: "approved" | "rejected") {
    setGone((g) => new Set(g).add(item.id)); // optimistic
    const res = await decide(item.tenantId, item.id, decision);
    if (!res.ok) {
      setGone((g) => { const n = new Set(g); n.delete(item.id); return n; });
      setToast(res.error ?? "That decision didn't go through — please try again.");
    } else {
      setToast(decision === "approved" ? "Approved — the requester has been notified." : "Declined — the requester has been notified.");
    }
    setTimeout(() => setToast(null), 2200);
  }

  if (visible.length === 0) {
    return (
      <div className="dash-empty">
        <p>All clear — nothing awaiting your review right now.</p>
      </div>
    );
  }
  return (
    <div>
      {visible.map((t) => (
        <div key={t.id} className="dash-approval">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="dash-approval__title">
              {t.campaignId ? <Link href={`/agency/${t.campaignId}`} style={{ color: "inherit", textDecoration: "none" }}>{t.subject}</Link> : t.subject}
            </div>
            <div className="dash-approval__meta">
              {t.company} · {t.campaignId ? <Link href={`/agency/${t.campaignId}`} style={{ color: "var(--erp-accent)", textDecoration: "none" }}>{t.campaign}</Link> : t.campaign}
            </div>
          </div>
          <div className="dash-approval__actions">
            <button title="Approve" className="dash-approval__btn dash-approval__btn--solid" onClick={() => act(t, "approved")}><Icon name="check" size={14} /></button>
            <button title="Decline" className="dash-approval__btn" onClick={() => act(t, "rejected")}><Icon name="x" size={14} /></button>
          </div>
        </div>
      ))}
      {toast && <Toast message={toast} />}
    </div>
  );
}
