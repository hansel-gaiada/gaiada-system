"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { requestKeyAction, type SiteScope } from "@/lib/webdeskContentActions";
import { KEY_REQUEST_COPY, keyRequestFailureCopy, type EnvironmentRef, type KeyScope } from "@/lib/webdeskContentModel";
import "./content.css";

// "Request an API key" — the site overview's small API-keys section.
//
// WHAT FILING MEANS. Nothing is created here. The BFF files ONE approval (HIGH impact); a DIFFERENT authorised user approves it, and
// the key is shown to THAT person, once, on the approval page (`KeyMintDecide`). So the only honest success copy is "Request filed",
// never "Key created". Asking again for the same (environment, scope) while one is open returns that request ("Already requested").
//
// WHO SEES IT. `allowed` is the page's `can(me, "webdev.promote", company)` — the UI mirror of Cerbos `promote` on
// `webdev_provisioned_site`, which is the BFF's gate. A user who cannot promote sees NOTHING here (no disabled button, no hint that the
// control exists). That is cosmetic: the BFF's `authorize()` is the authority, and a 403 still reads as a plain sentence below.
//
// ENVIRONMENTS come from the wall's existing site read (`loadSiteContext`), by name. With several to choose from there is no default,
// so a key is never requested for "whichever was first" by accident; a site with exactly one has it preselected.

type Message =
  | { tone: "ok" | "info"; text: string; approvalId: string }
  | { tone: "bad"; text: string };

export function RequestKeyPanel({
  allowed, scope, environments,
}: {
  allowed: boolean;
  scope: SiteScope;
  environments: EnvironmentRef[];
}) {
  const [envId, setEnvId] = useState(environments.length === 1 ? environments[0].envId : "");
  const [keyScope, setKeyScope] = useState<KeyScope>("read");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const mounted = useRef(true);
  // A ref, not `busy`: two submits in the same tick would both read `busy === false`.
  const inflight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  if (!allowed) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inflight.current || !envId) return;
    inflight.current = true;
    setBusy(true); setMessage(null);
    const r = await requestKeyAction(scope, envId, keyScope);
    inflight.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (r.kind === "ok") {
      setMessage(r.data.alreadyPending
        ? { tone: "info", text: KEY_REQUEST_COPY.alreadyPending, approvalId: r.data.approvalId }
        : { tone: "ok", text: KEY_REQUEST_COPY.filed, approvalId: r.data.approvalId });
    } else {
      setMessage({ tone: "bad", text: keyRequestFailureCopy(r) });
    }
  };

  return (
    <section className="wc-keys" aria-labelledby="wc-keys-h" data-testid="request-key">
      <h2 id="wc-keys-h" className="wc-group-head">API keys</h2>
      {environments.length === 0 ? (
        <p className="wc-muted" data-testid="request-key-no-env">This site has no environments yet, so there is nothing to request a key for.</p>
      ) : (
        <form className="wc-keys__form" onSubmit={submit} aria-label="Request an API key">
          <div className="lux-field">
            <label className="lux-field__label" htmlFor="rk-env">Environment</label>
            <select id="rk-env" className="lux-field__control" value={envId} onChange={(e) => { setEnvId(e.target.value); setMessage(null); }} disabled={busy}>
              {environments.length > 1 && <option value="">Choose an environment</option>}
              {environments.map((e) => <option key={e.envId} value={e.envId}>{e.name}</option>)}
            </select>
          </div>
          <div className="lux-field">
            <label className="lux-field__label" htmlFor="rk-scope">Scope</label>
            <select id="rk-scope" className="lux-field__control" value={keyScope} onChange={(e) => { setKeyScope(e.target.value as KeyScope); setMessage(null); }} disabled={busy} aria-describedby="rk-scope-hint">
              <option value="read">read</option>
              <option value="write">write</option>
            </select>
          </div>
          <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={busy || !envId} data-testid="request-key-submit">
            {busy ? "Requesting…" : "Request an API key"}
          </button>
          <p id="rk-scope-hint" className="lux-field__hint wc-keys__hint" data-testid="request-key-hint">{KEY_REQUEST_COPY.writeHint}</p>
        </form>
      )}
      {message && (
        <div className={`wc-banner wc-banner--${message.tone}`} role={message.tone === "bad" ? "alert" : "status"} data-testid="request-key-message">
          <span className="wc-banner__body">{message.text}</span>
          {"approvalId" in message && <Link className="lux-btn lux-btn--ghost lux-btn--sm" href={`/approvals/${encodeURIComponent(message.approvalId)}`}>{KEY_REQUEST_COPY.viewRequest}</Link>}
        </div>
      )}
    </section>
  );
}
