"use client";
import { useEffect, useRef, useState } from "react";
import { decideKeyMintApproval } from "@/app/(app)/actions";
import { Card } from "@/components/ui";
import { describeKeyMintError, type KeyMintDecideResult, type KeyMintOutcome } from "@/lib/webdeskContentModel";
import "./content.css";

// The decide control for a WebDesk key.mint approval, and the ONE place its API key is ever shown.
//
// WHY THIS IS NOT THE GENERIC DECIDE FORM. Approving a key.mint mints the key in-band, and the decide response carries it in
// `webdesk.plaintextOnce`: the only time it exists anywhere (WebDesk stores a hash; the row, activities, outbox and logs never hold
// it). The generic form posts to `decideApprovalItem`, which ignores the response body — a key approved that way was minted and thrown
// away. `decideKeyMintApproval` is its sibling that RETURNS the outcome; this component renders it.
//
// CUSTODY — hard rules, pinned by `KeyMintDecide.test.tsx` (which spies on Storage and console):
//   1. The key lives ONLY in this component's React state (`result`), for this render. It is never written to localStorage,
//      sessionStorage, IndexedDB, a cookie, the URL, a query string or history state, and never passed to `console.*`.
//   2. No server round trip after the one that delivered it ever carries it: the action's revalidation re-renders the approval
//      page from the decided ROW, which has no key. This component stays mounted across that re-render (it is rendered for every
//      key.mint row, whatever `mayDecide` says), which is what keeps the panel on screen after the row stops being pending.
//   3. Navigating away unmounts it and the key is gone — and a refresh shows no key. That is correct, not a bug: the warning says so.
//   4. A page restored from the back/forward cache (`pageshow` with `persisted`) would otherwise bring the old DOM, key and all,
//      back to life; that event clears the state.

type Busy = "approved" | "rejected" | null;

export function KeyMintDecide({
  tenantId, approvalId, environmentName, mayDecide, ownRequest,
}: {
  tenantId: string;
  approvalId: string;
  /** The environment's name when the workspace's site read could resolve it; the panel falls back to the id. */
  environmentName: string | null;
  /** `can(me, "approvals.decide", tenant)` and the row is still pending — the page's own gate, cosmetic like every UI gate. */
  mayDecide: boolean;
  /** The caller filed this request: a key mint is never self-approvable (maker ≠ checker), so the buttons would only 403. */
  ownRequest: boolean;
}) {
  const [result, setResult] = useState<KeyMintDecideResult | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  // Set by a successful decision and NEVER cleared (not by "Hide key" either): a second Approve would try to mint again.
  const [done, setDone] = useState(false);
  const [note, setNote] = useState("");
  const mounted = useRef(true);
  // A ref, not `busy`: two clicks in one tick would both read `busy === null`, and each Approve mints a key.
  const inflight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Custody rule 4.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) setResult(null); };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const decide = async (decision: "approved" | "rejected") => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(decision);
    const r = await decideKeyMintApproval(tenantId, approvalId, decision, note.trim() || undefined);
    inflight.current = false;
    if (!mounted.current) return;
    setBusy(null);
    if (r.ok) setDone(true);
    setResult(r);
  };

  const decided = done;

  return (
    <>
      {result && <Outcome result={result} environmentName={environmentName} onHide={() => setResult(null)} />}
      {!decided && mayDecide && ownRequest && (
        <Card title="Decide">
          <p className="wc-muted" data-testid="key-own-request" style={{ margin: 0 }}>
            You filed this request, so someone else has to approve it. A key is never created by the person who asked for it.
          </p>
        </Card>
      )}
      {!decided && mayDecide && !ownRequest && (
        <Card title="Decide">
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label style={{ display: "grid", gap: 4, flex: "1 1 260px" }}>
              <span style={{ font: "500 12px var(--font-body)", color: "var(--ink-subtle)" }}>Note (optional)</span>
              <input type="text" name="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the record" disabled={busy !== null} />
            </label>
            <button type="button" className="btn btn-primary" style={{ fontSize: 13 }} onClick={() => decide("approved")} disabled={busy !== null}>
              {busy === "approved" ? "Approving…" : "Approve"}
            </button>
            <button type="button" className="btn" style={{ fontSize: 13 }} onClick={() => decide("rejected")} disabled={busy !== null}>
              {busy === "rejected" ? "Denying…" : "Deny"}
            </button>
          </div>
          <p className="wc-muted" style={{ margin: "10px 0 0" }}>
            Approving creates the key now and shows it to you once, on this page.
          </p>
        </Card>
      )}
    </>
  );
}

function Outcome({ result, environmentName, onHide }: { result: KeyMintDecideResult; environmentName: string | null; onHide: () => void }) {
  if (!result.ok) {
    return <div className="wc-banner wc-banner--bad" role="alert" data-testid="key-decide-error"><span className="wc-banner__body">Couldn&apos;t record your decision. {result.error}</span></div>;
  }
  if (result.decision === "rejected") {
    return <div className="wc-banner wc-banner--info" role="status" data-testid="key-denied"><span className="wc-banner__body">Request denied. No key was created.</span></div>;
  }
  return <Minted mint={result.mint} environmentName={environmentName} onHide={onHide} />;
}

function Minted({ mint, environmentName, onHide }: { mint: KeyMintOutcome; environmentName: string | null; onHide: () => void }) {
  if (mint.status === "failed") {
    return (
      <div className="wc-banner wc-banner--bad" role="alert" data-testid="key-failed">
        <span className="wc-banner__body"><strong>The key wasn&apos;t created.</strong> {describeKeyMintError(mint.error)} Ask the requester to file a new request.</span>
      </div>
    );
  }
  if (mint.status === "unreadable") {
    return (
      <div className="wc-banner wc-banner--bad" role="alert" data-testid="key-unreadable">
        <span className="wc-banner__body">
          <strong>Approved, but no key can be shown.</strong> WebDesk&apos;s answer wasn&apos;t in the shape the ERP expects. If a key was created it can&apos;t be recovered, so ask the requester to file a new request.
        </span>
      </div>
    );
  }
  if (mint.plaintextOnce === null) {
    return (
      <div className="wc-banner wc-banner--bad" role="alert" data-testid="key-not-returned">
        <span className="wc-banner__body">
          <strong>The key was created, but WebDesk didn&apos;t send it back,</strong> so it can&apos;t be shown. Ask the requester to file a new request.
        </span>
      </div>
    );
  }
  return <KeyOnce environment={environmentName ?? mint.envId} scope={mint.scope} apiKeyId={mint.apiKeyId} value={mint.plaintextOnce} onHide={onHide} />;
}

function KeyOnce({ environment, scope, apiKeyId, value, onHide }: { environment: string; scope: string; apiKeyId: string | null; value: string; onHide: () => void }) {
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("ok");
    } catch {
      // No clipboard permission / insecure context: the field is selectable, so the fallback is on screen, not a log line.
      setCopied("fail");
    }
  };
  return (
    <Card title="API key created">
      <div className="wc-key-once" data-testid="key-once">
        <dl className="wc-key-once__facts">
          <div><dt>Environment</dt><dd data-testid="key-once-env">{environment}</dd></div>
          <div><dt>Scope</dt><dd data-testid="key-once-scope">{scope}</dd></div>
          {apiKeyId && <div><dt>Key id</dt><dd className="wc-mono">{apiKeyId}</dd></div>}
        </dl>
        <div className="wc-banner wc-banner--warn" role="alert" data-testid="key-once-warning">
          <span className="wc-banner__body"><strong>Copy this key now. It won&apos;t be shown again: WebDesk keeps only a fingerprint of it.</strong></span>
        </div>
        <div className="wc-key-once__row">
          <input
            type="text" readOnly value={value} aria-label="API key" data-testid="key-once-value"
            className="lux-field__control wc-key-once__value" spellCheck={false} autoComplete="off"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={copy} data-testid="key-once-copy">Copy</button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onHide}>Hide key</button>
        </div>
        {copied === "ok" && <p className="wc-muted" role="status" data-testid="key-once-copied" style={{ margin: 0 }}>Copied to the clipboard.</p>}
        {copied === "fail" && <p className="wc-muted" role="status" data-testid="key-once-copy-failed" style={{ margin: 0 }}>Couldn&apos;t copy automatically. Select the key above and copy it by hand.</p>}
      </div>
    </Card>
  );
}
