"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { withdrawNoticeAction } from "@/lib/noticeActions";
import type { NoticeRow } from "@/lib/notices";
import { NoticeForm } from "./NoticeForm";
import "./notices.css";

// DW-10a-2 (BFF §57.8): Edit and Withdraw for one notice. The page draws this only when the notice's own `canEdit` is true (the caller's `edit`
// right on that row); the server decides again on the write. Withdraw asks first, because it takes the notice off every list for everyone.

export function NoticeControls({ tenantId, notice, children }: {
  tenantId: string;
  notice: NoticeRow;
  /** The notice as read (title, body, meta): hidden while the edit form is open, so the form replaces it. */
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const withdraw = () => {
    startTransition(async () => {
      const res = await withdrawNoticeAction(tenantId, notice.id, notice.scope);
      if (res.ok) {
        setMsg(null);
        router.refresh();
      } else {
        setMsg(res.error ?? "The notice could not be withdrawn.");
        setMode("view");
      }
    });
  };

  if (mode === "edit") {
    return (
      <NoticeForm
        tenantId={tenantId}
        target={notice.scope === "company" ? { scope: "company" } : { scope: "unit", unitNodeId: notice.unitNodeId ?? "" }}
        notice={notice}
        onDone={() => setMode("view")}
        onCancel={() => setMode("view")}
      />
    );
  }

  return (
    <>
      {children}
      {mode === "confirm" ? (
        <div className="nt-confirm" role="group" aria-label={`Withdraw ${notice.title}?`}>
          <span>Withdraw this notice? It leaves every list, for everyone, and cannot be brought back.</span>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={withdraw}>
            {pending ? "Withdrawing…" : "Yes, withdraw it"}
          </button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => setMode("view")}>
            Keep it
          </button>
        </div>
      ) : (
        <div className="nt-actions">
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Edit ${notice.title}`} onClick={() => { setMsg(null); setMode("edit"); }}>
            Edit
          </button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Withdraw ${notice.title}`} onClick={() => { setMsg(null); setMode("confirm"); }}>
            Withdraw
          </button>
          {msg && <span role="alert" className="nt-msg nt-msg--bad">{msg}</span>}
        </div>
      )}
    </>
  );
}
