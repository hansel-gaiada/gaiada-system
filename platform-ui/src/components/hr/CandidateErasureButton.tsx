"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RecruitmentResult } from "@/lib/hrRecruitmentActions";
import { ResultMessage, panelStyle, textStyle, type Msg } from "./RecruitmentBits";

// "Request erasure" for one candidate (DW-7f-2). A confirmation first, because it starts a data-protection
// process. It is not a delete: the server stamps the row, and a retention sweep purges it later (an
// application in flight is not cut off). Asking twice is harmless. The manage tier only; the page decides
// whether to render this, the server decides whether to allow it.
export function CandidateErasureButton({ tenantId, candidateId, name, erase }: {
  tenantId: string;
  candidateId: string;
  name: string;
  erase: (tenantId: string, candidateId: string) => Promise<RecruitmentResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);

  function run() {
    startTransition(async () => {
      const res = await erase(tenantId, candidateId);
      if (res.ok) { setMsg({ ok: true, text: res.notice ?? "Erasure requested." }); setConfirming(false); }
      else setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      router.refresh();
    });
  }

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {!confirming && (
        <div>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
            aria-label={`Request erasure of ${name}`} onClick={() => { setConfirming(true); setMsg(null); }}>
            Request erasure
          </button>
        </div>
      )}
      {confirming && (
        <div role="group" aria-label={`Confirm erasure of ${name}`} style={panelStyle}>
          <p style={textStyle}>
            Request erasure of {name}&apos;s personal data? This marks the record for the retention sweep, which
            purges it. It is not undone from here.
          </p>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={run}>
              {pending ? "Requesting…" : "Yes, request erasure"}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {msg && <ResultMessage msg={msg} />}
    </div>
  );
}
