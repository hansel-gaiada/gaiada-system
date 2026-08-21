// AGPL-3.0 §13 source-offer — tracked gap closed (docs/plans/smm-tracker.md, "Open items not
// owned by any ticket"). Postiz (the publishing engine every tab in this department calls over
// the network — infra/compose/docker-compose.social.yml) is AGPL-3.0. §13 requires offering its
// Corresponding Source to anyone whose network interaction it relays, which is STAFF working this
// console, not a client (the client portal, `PortalShell.tsx`, never talks to Postiz). Rendered
// only on the Social Media department's own console (gated in `[deptId]/layout.tsx` on the
// resolved toolkit's slug, never the generic staff shell) — every other department's pages never
// touch Postiz, so a console-wide footer would put a Postiz notice in front of people it has
// nothing to do with.
//
// WORDING CONTRACT — read this before editing the copy below:
// The sentence never asserts "unmodified" or names a version number, on purpose: that claim would
// go silently false the day D-21's fork exception (TikTok `creator_info` + the IG quota probe,
// ~15 lines, granted but NOT YET applied — see the tracker's Decision-gated table) lands, and
// nothing here would catch it. The copy instead promises "the source for exactly what we run,"
// which stays true in both states — only the LINK TARGET has to move. **When D-21 is applied,
// this href must change from the upstream repo to wherever the patched source (a public fork or
// mirror, reachable without repo access this console's own staff may not have) is published.**
// That is a real follow-up for whoever lands D-21, tracked in the same tracker row as the
// exception itself — not a second, separate gap.
export function SourceOfferNotice() {
  return (
    <footer
      role="note"
      aria-label="Open-source notice"
      style={{
        marginTop: 32,
        borderTop: "0.5px solid var(--erp-hairline)",
        paddingTop: 16,
        font: "400 12px/1.6 var(--font-body)",
        color: "var(--ink-muted)",
      }}
    >
      Calendar, Composer, Inbox and Analytics reach your connected networks through Postiz, a
      separate publishing engine we run as its own service. Postiz is licensed under the{" "}
      <strong>GNU Affero General Public License v3.0 (AGPL-3.0)</strong>, which entitles anyone
      whose network interaction it relays — that&rsquo;s you, using these tools — to its
      Corresponding Source. That includes Postiz&rsquo;s own web frontend, also AGPL-3.0, even
      though this console never exposes it.{" "}
      <a
        href="https://github.com/gitroomhq/postiz-app"
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "var(--erp-accent)", textDecoration: "underline" }}
      >
        Get the source for exactly the version we run
      </a>
      .
    </footer>
  );
}
