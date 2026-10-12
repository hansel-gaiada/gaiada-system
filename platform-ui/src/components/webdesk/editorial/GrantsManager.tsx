"use client";
import { useState } from "react";
import { grantRoleAction, listGrantsAction, revokeRoleAction, type EditorialScope } from "@/lib/webdeskEditorialActions";
import { authorLabel, isOutcomeUnknown, type WdResult } from "@/lib/webdeskContentModel";
import {
  EDITORIAL_ROLES, grantRefusalCopy, roleLabel, ROLE_INFO, scopeWords,
  type EditorialGrant, type EditorialRole, type GrantsBody,
} from "@/lib/webdeskEditorialModel";
import { formatDateTime } from "@/lib/format";
import "./editorial.css";

// `writers/people/[tenant]/[site]` — who holds which writers' room role on this site (M5-W1b's routes). The BFF decides who may even
// read this list (`manage_editorial`: company admin, owner, Web Dev manager); the PAGE shows a plain "you can't manage writers here"
// for a 403 and never reaches this component. Everything the BFF refuses is shown in words and keeps what was typed. Granting the
// same role again REPLACES this site's scope (the BFF's rule), and an empty list never means "all": the form sends exactly one of
// "every collection" / a list, and the same for languages.

const dayEnd = (day: string): string | null => (day === "" ? null : `${day}T23:59:59.000Z`);

export function GrantsManager({
  scope, initial, people, collections, locales,
}: {
  scope: EditorialScope;
  initial: GrantsBody;
  /** The company's people (id -> display name): the picker AND the names in the table. */
  people: Record<string, string>;
  /** The site's collection keys. */
  collections: string[];
  /** The site's languages. */
  locales: string[];
}) {
  const [grants, setGrants] = useState<EditorialGrant[]>(initial.grants);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<EditorialRole>("webdesk_writer");
  const [allCollections, setAllCollections] = useState(false);
  const [pickedCollections, setPickedCollections] = useState<string[]>([]);
  const [allLocales, setAllLocales] = useState(true);
  const [pickedLocales, setPickedLocales] = useState<string[]>([]);
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const names = Object.entries(people).sort((a, b) => a[1].localeCompare(b[1]));
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const refresh = async (): Promise<boolean> => {
    let r: WdResult<GrantsBody>;
    try { r = await listGrantsAction(scope); } catch { r = { kind: "unavailable", code: "network", reason: "network" }; }
    if (r.kind === "ok") { setGrants(r.data.grants); return true; }
    setMsg({ tone: "warn", text: `The change went through, but the list couldn't be refreshed: ${grantRefusalCopy(r)}` });
    return false;
  };

  const canSubmit = userId !== "" && (allCollections || pickedCollections.length > 0) && (allLocales || pickedLocales.length > 0) && !busy;

  const give = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (expires !== "" && Date.parse(dayEnd(expires) as string) <= Date.now()) { setMsg({ tone: "bad", text: "The expiry date has to be in the future." }); return; }
    setBusy(true); setMsg(null);
    let r;
    try {
      r = await grantRoleAction(scope, { userId, role, allCollections, collections: pickedCollections, allLocales, locales: pickedLocales, expiresAt: dayEnd(expires) });
    } catch { r = { kind: "unavailable", code: "network", reason: "network" } as const; }
    if (r.kind === "ok") {
      setMsg({ tone: "ok", text: r.data.changed
        ? `${roleLabel(role)} given to ${authorLabel(userId, people)} on this site. They are signed out of their current session and sign in again to use it.`
        : `${authorLabel(userId, people)} already had exactly this. Nothing changed.` });
      await refresh();
    } else {
      setMsg({ tone: "bad", text: grantRefusalCopy(r) });
      if (isOutcomeUnknown(r)) await refresh();
    }
    setBusy(false);
  };

  const remove = async (g: EditorialGrant) => {
    setBusy(true); setMsg(null); setConfirming(null);
    let r;
    try { r = await revokeRoleAction(scope, g.userId, g.role); } catch { r = { kind: "unavailable", code: "network", reason: "network" } as const; }
    if (r.kind === "ok") {
      setMsg({ tone: "ok", text: r.data.changed ? `${roleLabel(g.role)} removed from ${g.name ?? authorLabel(g.userId, people)} on this site.` : "They didn't hold that role any more. Nothing changed." });
      await refresh();
    } else {
      setMsg({ tone: "bad", text: grantRefusalCopy(r) });
      if (isOutcomeUnknown(r)) await refresh();
    }
    setBusy(false);
  };

  return (
    <div className="wc-page" data-testid="grants-manager">
      {msg && (
        <div className={`wc-banner wc-banner--${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"} data-testid={`grants-${msg.tone}`}>
          <span className="wc-banner__body">{msg.text}</span>
        </div>
      )}

      {grants.length === 0 ? (
        <p className="wc-muted" data-testid="grants-empty">Nobody holds a writers&apos; room role on this site yet.</p>
      ) : (
        <div className="wc-scroll">
          <table className="wc-table" data-testid="grants-table">
            <thead>
              <tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Collections</th><th scope="col">Languages</th><th scope="col">Expires</th><th scope="col">Given by</th><th scope="col"><span className="wc-sr">Actions</span></th></tr>
            </thead>
            <tbody>
              {grants.map((g) => {
                const k = `${g.userId}:${g.role}`;
                const who = g.name ?? authorLabel(g.userId, people);
                return (
                  <tr key={k} data-testid="grant-row">
                    <td>{who}{g.email ? <><br /><span className="wc-muted">{g.email}</span></> : null}</td>
                    <td title={(ROLE_INFO as Record<string, { sentence: string }>)[g.role]?.sentence}>{roleLabel(g.role)}</td>
                    <td>{scopeWords(g.allCollections, g.collections, "collection")}</td>
                    <td>{scopeWords(g.allLocales, g.locales, "language")}</td>
                    <td>{g.expiresAt ? formatDateTime(g.expiresAt) : "never"}</td>
                    <td>{g.grantedBy ? authorLabel(g.grantedBy, people) : "—"}</td>
                    <td>
                      {confirming === k ? (
                        <span className="we-actions">
                          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => void remove(g)} disabled={busy} data-testid="grant-revoke-confirm">Remove {roleLabel(g.role)} from {who}</button>
                          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirming(null)}>Keep</button>
                        </span>
                      ) : (
                        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirming(k)} disabled={busy} data-testid="grant-revoke">Remove…</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <form className="we-form" onSubmit={give} aria-label="Give a writers' room role" data-testid="grant-form">
        <h3 className="wc-group-head">Give a role on this site</h3>
        <div className="we-form__row">
          <div className="lux-field">
            <label className="lux-field__label lux-field__label--req" htmlFor="wg-person">Person</label>
            <select id="wg-person" className="lux-field__control" value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="grant-person">
              <option value="">Choose a person</option>
              {names.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </div>
          <div className="lux-field">
            <label className="lux-field__label lux-field__label--req" htmlFor="wg-role">Role</label>
            <select id="wg-role" className="lux-field__control" value={role} onChange={(e) => setRole(e.target.value as EditorialRole)} data-testid="grant-role">
              {EDITORIAL_ROLES.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
            </select>
          </div>
        </div>
        <p className="wc-publish__sub" data-testid="grant-role-sentence">{ROLE_INFO[role].sentence}</p>

        <fieldset className="we-scope">
          <legend>Collections</legend>
          <label className="we-check"><input type="checkbox" checked={allCollections} onChange={(e) => setAllCollections(e.target.checked)} data-testid="grant-all-collections" /> Every collection</label>
          {collections.map((c) => (
            <label key={c} className="we-check"><input type="checkbox" disabled={allCollections} checked={allCollections || pickedCollections.includes(c)} onChange={() => setPickedCollections((l) => toggle(l, c))} /> {c}</label>
          ))}
        </fieldset>
        <fieldset className="we-scope">
          <legend>Languages</legend>
          <label className="we-check"><input type="checkbox" checked={allLocales} onChange={(e) => setAllLocales(e.target.checked)} data-testid="grant-all-locales" /> Every language</label>
          {locales.map((l) => (
            <label key={l} className="we-check"><input type="checkbox" disabled={allLocales} checked={allLocales || pickedLocales.includes(l)} onChange={() => setPickedLocales((x) => toggle(x, l))} /> {l}</label>
          ))}
        </fieldset>

        <div className="lux-field">
          <label className="lux-field__label" htmlFor="wg-exp">Expires (optional)</label>
          <input id="wg-exp" type="date" className="lux-field__control" value={expires} onChange={(e) => setExpires(e.target.value)} data-testid="grant-expires" />
          <span className="lux-field__hint">The expiry belongs to the person&apos;s role on every site, not just this one. Giving a role again replaces what it covers on this site.</span>
        </div>
        <div className="we-actions">
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={!canSubmit} data-testid="grant-submit">Give role</button>
        </div>
      </form>
    </div>
  );
}
