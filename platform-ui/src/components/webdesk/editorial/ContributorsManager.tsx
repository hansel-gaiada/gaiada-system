"use client";
import { useState } from "react";
import { endContributorAction, inviteContributorAction, listContributorsAction } from "@/lib/contributorsAdminActions";
import { contributorRefusalCopy, maxValidUntilDay, statusWords, validEmail, validUntilFromDay, MAX_ENGAGEMENT_DAYS, type ContributorInvited, type ContributorRow } from "@/lib/contributorsAdminModel";
import { isOutcomeUnknown, type WdResult } from "@/lib/webdeskContentModel";
import { formatDateTime } from "@/lib/format";
import "./editorial.css";

// M5-W1f: freelance contributors, on the writers' room people page (publisher tier: the BFF decides, a 403 is a refusal in words and never an empty
// list). Invite one (email, optional name, an end date at most 180 days ahead), see everyone invited here, and End an engagement. The invite's link is
// shown ONCE, here, and never stored: the backend keeps only a hash, so a lost link means a new invite. Granting what they may write stays in the
// roles table above (the three contributor roles only, time-boxed inside the engagement).
const dayOf = (iso: string): string => iso.slice(0, 10);

export function ContributorsManager({ initial }: { initial: ContributorRow[] }) {
  const [rows, setRows] = useState<ContributorRow[]>(initial);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);
  const [invite, setInvite] = useState<ContributorInvited | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const untilCheck = until === "" ? null : validUntilFromDay(until);
  const canSubmit = validEmail(email) && untilCheck?.ok === true && !busy;

  const refresh = async (): Promise<void> => {
    let r: WdResult<ContributorRow[]>;
    try { r = await listContributorsAction(); } catch { r = { kind: "unavailable", code: "network", reason: "network" }; }
    if (r.kind === "ok") setRows(r.data);
    else setMsg({ tone: "warn", text: `The change went through, but the list couldn't be refreshed: ${contributorRefusalCopy(r)}` });
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setMsg(null); setInvite(null); setCopied(false);
    let r: WdResult<ContributorInvited>;
    try { r = await inviteContributorAction({ email, name, validUntilDay: until }); } catch { r = { kind: "unavailable", code: "network", reason: "network" }; }
    if (r.kind === "ok") {
      setInvite(r.data);
      setMsg({ tone: "ok", text: `${r.data.contributor.email ?? email} is invited until ${formatDateTime(r.data.contributor.validUntil)}. Send them the link below: it is shown only now.` });
      setEmail(""); setName(""); setUntil("");
      await refresh();
    } else {
      // The typed fields stay, so a refusal can be fixed and retried.
      setMsg({ tone: "bad", text: contributorRefusalCopy(r) });
      if (isOutcomeUnknown(r)) await refresh();
    }
    setBusy(false);
  };

  const end = async (c: ContributorRow) => {
    setBusy(true); setMsg(null); setConfirming(null);
    let r;
    try { r = await endContributorAction(c.userId); } catch { r = { kind: "unavailable", code: "network", reason: "network" } as const; }
    if (r.kind === "ok") {
      const who = c.name ?? c.email ?? "The contributor";
      setMsg({
        tone: "ok",
        text: !r.data.changed
          ? `${who}'s engagement had already ended. Nothing changed.`
          : `${who}'s engagement is ended: ${r.data.revokedGrantCount} writers' room role${r.data.revokedGrantCount === 1 ? "" : "s"} removed and their session cut. ${
            r.data.keptLoginForOtherEngagements ? "Their login stays because they have another live engagement." : r.data.idpDisabled ? "Their login is disabled." : "Their login could not be confirmed as disabled; check the identity service."}`,
      });
      await refresh();
    } else {
      setMsg({ tone: "bad", text: contributorRefusalCopy(r) });
      if (isOutcomeUnknown(r)) await refresh();
    }
    setBusy(false);
  };

  const copy = () => {
    if (!invite) return;
    void navigator.clipboard?.writeText(invite.acceptUrl).then(() => setCopied(true), () => setCopied(false));
  };

  return (
    <section className="wc-page" aria-labelledby="we-contrib-h" data-testid="contributors-manager">
      <h3 id="we-contrib-h" className="wc-group-head">Freelance contributors</h3>
      <p className="wc-lede">
        A freelance writer, translator or SEO reviewer signs in to their own screens and sees only what you give them below. An engagement lasts at most {MAX_ENGAGEMENT_DAYS} days.
        After they accept, give them a role in the table above.
      </p>

      <form className="we-form" onSubmit={send} aria-label="Invite a freelance contributor" data-testid="contributor-invite-form">
        <div className="we-form__row">
          <div className="lux-field">
            <label className="lux-field__label lux-field__label--req" htmlFor="we-ct-email">Email</label>
            <input id="we-ct-email" type="email" className="lux-field__control" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="off" data-testid="contributor-email" />
          </div>
          <div className="lux-field">
            <label className="lux-field__label" htmlFor="we-ct-name">Name (optional)</label>
            <input id="we-ct-name" className="lux-field__control" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} data-testid="contributor-name" />
          </div>
          <div className="lux-field">
            <label className="lux-field__label lux-field__label--req" htmlFor="we-ct-until">Engagement ends</label>
            <input id="we-ct-until" type="date" className="lux-field__control" value={until} onChange={(e) => setUntil(e.target.value)} max={maxValidUntilDay()} data-testid="contributor-until" />
            <span className="lux-field__hint">The end of that day, UTC. At most {MAX_ENGAGEMENT_DAYS} days from today.</span>
          </div>
        </div>
        {untilCheck && !untilCheck.ok && <p className="we-why" role="note" data-testid="contributor-until-bad">{untilCheck.message}</p>}
        <div className="we-actions">
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={!canSubmit} data-testid="contributor-invite-send">Invite</button>
        </div>
      </form>

      {msg && (
        <div className={`wc-banner wc-banner--${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"} data-testid={`contributors-msg-${msg.tone}`}>
          <span className="wc-banner__body">{msg.text}</span>
        </div>
      )}

      {invite && (
        <div className="wc-side-card" data-testid="contributor-link-card">
          <h3>One-time link</h3>
          <p className="wc-publish__sub">Send this to {invite.contributor.email ?? "them"} yourself. It works for 72 hours (until {formatDateTime(invite.expiresAt)}), once, and it is not shown again.</p>
          <code style={{ display: "block", padding: "8px 10px", background: "var(--surface-sunken)", borderRadius: 8, font: "400 12px/1.5 var(--font-mono, monospace)", wordBreak: "break-all", color: "var(--ink)" }} data-testid="contributor-link">{invite.acceptUrl}</code>
          <div className="we-actions">
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={copy} data-testid="contributor-link-copy">{copied ? "Copied" : "Copy link"}</button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setInvite(null)} data-testid="contributor-link-dismiss">Done, hide it</button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="we-why" data-testid="contributors-empty">No freelance contributors have been invited in this company yet.</p>
      ) : (
        <div className="wc-scroll"><table className="wc-table" data-testid="contributors-table">
          <thead><tr><th scope="col">Person</th><th scope="col">Status</th><th scope="col">Until</th><th scope="col"><span className="wc-sr">Actions</span></th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.contributorId} data-testid="contributor-row">
                <td>{c.name ?? "(no name)"}<br /><span className="wc-muted">{c.email ?? "no email"}</span></td>
                <td data-testid="contributor-status">{statusWords(c)}</td>
                <td>{c.status === "ended" && c.endedAt ? `ended ${dayOf(c.endedAt)}` : dayOf(c.validUntil)}</td>
                <td>
                  {c.status === "ended" ? null : confirming === c.userId ? (
                    <span className="we-actions">
                      <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => void end(c)} disabled={busy} data-testid="contributor-end-confirm">End it</button>
                      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirming(null)}>Cancel</button>
                    </span>
                  ) : (
                    <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirming(c.userId)} disabled={busy} data-testid="contributor-end">End</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
