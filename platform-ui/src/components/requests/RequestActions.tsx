"use client";
// DW-5c UI — the actions on a request page: Cancel, Deliver (and Deliver more) and Decline. The page decides who is
// OFFERED each (`requestActions`: cosmetic), and the server refuses anything it must, so a 403 or a 409 from an action
// renders as a sentence below the control, never as a silent no-op.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { cancelOutboundRequestAction, cancelRequestAction, declineRequestAction, deliverRequestAction } from "@/lib/requestActions";
import { LIMITS, checkDeclineReason, checkDeliverIds, type OfferedActions } from "@/lib/requests";
import "@/components/forms/forms.css";
import "./requests.css";

export interface LibraryChoice { id: string; name: string; contentType: string }

export interface RequestActionsProps {
  requestId: string;
  offered: OfferedActions;
  /** The Asset Library, minus what is already delivered on this request. `null` when it could not be read. */
  library: LibraryChoice[] | null;
  /** Why the library could not be read, in the backend's words. */
  libraryReason?: string | null;
  /** DW-10e: this is the SENDER's page for a request to another group company (`/requests/outbound/<id>`). Cancel then goes through the
   *  sender route, under the asking company. */
  outbound?: boolean;
}

type Mode = "none" | "cancel" | "deliver" | "decline";

export function RequestActions({ requestId, offered, library, libraryReason, outbound = false }: RequestActionsProps) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("none");
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const deliverLabel = offered.deliverMore ? "Deliver more assets" : "Deliver assets";
  const anyOffered = offered.cancel || offered.deliver || offered.deliverMore || offered.decline;
  if (!anyOffered) return null;

  function open(next: Mode) {
    setMode(mode === next ? "none" : next);
    setError(null);
  }
  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) return setError(res.error);
      setMode("none");
      setPicked([]);
      setReason("");
      router.refresh();
    });
  }

  function submitDeliver() {
    const bad = checkDeliverIds(picked);
    if (bad) return setError(bad);
    run(() => deliverRequestAction(requestId, picked));
  }
  function submitDecline() {
    const bad = checkDeclineReason(reason);
    if (bad) return setError(bad);
    run(() => declineRequestAction(requestId, reason));
  }
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <div className="req-stack">
      <div className="req-actions">
        {(offered.deliver || offered.deliverMore) && (
          <Button size="sm" onClick={() => open("deliver")} disabled={pending}>{deliverLabel}</Button>
        )}
        {offered.decline && <Button variant="ghost" size="sm" onClick={() => open("decline")} disabled={pending}>Decline</Button>}
        {offered.cancel && <Button variant="ghost" size="sm" onClick={() => open("cancel")} disabled={pending}>Cancel request</Button>}
      </div>

      {mode === "deliver" && (
        <div className="req-stack" role="group" aria-label={deliverLabel}>
          {library === null ? (
            <p className="req-note">
              The Asset Library could not be read{libraryReason ? ` (${libraryReason})` : ""}, so assets cannot be chosen now. Try again in a moment.
            </p>
          ) : library.length === 0 ? (
            <p className="req-empty">There is nothing left in the Asset Library to deliver. Save an asset to the library first.</p>
          ) : (
            <>
              <p className="req-note">Choose 1 to {LIMITS.assetIds} assets from the Asset Library. {picked.length} chosen.</p>
              <div className="req-pick">
                {library.map((a) => (
                  <label key={a.id} className="req-pick__item">
                    <input type="checkbox" checked={picked.includes(a.id)} onChange={() => toggle(a.id)} disabled={pending} />
                    <span>{a.name}</span>
                    <span className="req-pick__meta">{a.contentType}</span>
                  </label>
                ))}
              </div>
              <div className="req-actions">
                <Button size="sm" onClick={submitDeliver} disabled={pending || picked.length === 0}>
                  {pending ? "Delivering…" : picked.length === 0 ? "Deliver" : `Deliver ${picked.length} ${picked.length === 1 ? "asset" : "assets"}`}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {mode === "decline" && (
        <div className="req-stack" role="group" aria-label="Decline this request">
          <label className="lux-field">
            <span className="lux-field__label lux-field__label--req">Reason</span>
            <textarea
              className="lux-field__control lux-field__control--textarea"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
              maxLength={LIMITS.reason * 2}
              aria-label="Reason"
            />
            <span className="lux-field__hint">The requester sees this. Up to {LIMITS.reason.toLocaleString("en-US")} characters.</span>
          </label>
          <div className="req-actions">
            <Button size="sm" onClick={submitDecline} disabled={pending}>{pending ? "Declining…" : "Decline request"}</Button>
          </div>
        </div>
      )}

      {mode === "cancel" && (
        <div className="req-actions" role="group" aria-label="Cancel this request">
          <span className="req-note">Cancel this request? The receiving team stops working on it.</span>
          <Button size="sm" onClick={() => run(() => (outbound ? cancelOutboundRequestAction(requestId) : cancelRequestAction(requestId)))} disabled={pending}>{pending ? "Cancelling…" : "Yes, cancel it"}</Button>
          <Button variant="ghost" size="sm" onClick={() => setMode("none")} disabled={pending}>Keep it</Button>
        </div>
      )}

      {error && <p className="req-error" role="alert">{error}</p>}
    </div>
  );
}
