import Link from "next/link";
import { monthLabel, monthOptions, socialHref, type PortalSocialCounts, type PortalSocialTab } from "@/lib/portalSocial";
import "./portalSocial.css";

// SCP-2 (BFF §63.9) — the server-rendered parts of the approval page: the counts, the month and client filters and the tabs. No state and no script: the
// counts are links to the tab that holds them, the filters are a plain GET form (it works before any script has loaded), and the tabs are links
// (`?tab=`), so each is reachable by keyboard and each URL can be shared or reloaded. They keep each other's parameters (the tab keeps the month).
export interface SocialQuery { tab: PortalSocialTab; month: string | null; clientId: string | null }

/** "To approve", "Approved", "Changes asked": the counts of the filtered month and client. Each one opens the tab that lists those posts. */
export function PortalSocialCountsBar({ counts, q }: { counts: PortalSocialCounts; q: SocialQuery }) {
  const items: Array<{ key: string; n: number; label: string; href: string; wait?: boolean }> = [
    { key: "to_review", n: counts.toReview, label: "To approve", href: socialHref(q, { tab: "to_review", cursor: null, post: null }), wait: counts.toReview > 0 },
    { key: "approved", n: counts.approved, label: "Approved", href: socialHref(q, { tab: "approved", cursor: null, post: null }) },
    { key: "changes", n: counts.changesAsked, label: "Changes asked", href: socialHref(q, { tab: "grid", cursor: null, post: null }) },
  ];
  return (
    <ul className="ps-counts" aria-label="Where your posts stand">
      {items.map((i) => (
        <li key={i.key}>
          <Link href={i.href} className="ps-counts__link">
            <span className={`ps-counts__n${i.wait ? " ps-counts__n--wait" : ""}`}>{i.n}</span>
            <span className="ps-counts__label">{i.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The month switcher and, when the contact has more than one client, the client filter. A GET form: "Show" reloads the page with the choice in the URL. */
export function PortalSocialFilters({ q, todayMonth, clients }: { q: SocialQuery; todayMonth: string; clients: Array<{ id: string; name: string }> }) {
  return (
    <form method="get" action="/portal/social" className="ps-filters" aria-label="Choose the month and the client">
      {q.tab !== "to_review" && <input type="hidden" name="tab" value={q.tab} />}
      <div className="ps-filters__field">
        <label className="cp-field__label" htmlFor="ps-month">Month</label>
        <select id="ps-month" name="month" className="cp-select" defaultValue={q.month ?? ""}>
          <option value="">All months</option>
          {monthOptions(todayMonth, q.month).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
      </div>
      {clients.length > 1 && (
        <div className="ps-filters__field">
          <label className="cp-field__label" htmlFor="ps-client">Client</label>
          <select id="ps-client" name="clientId" className="cp-select" defaultValue={q.clientId ?? ""}>
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      )}
      <button type="submit" className="btn ps-btn">Show</button>
    </form>
  );
}

const TABS: Array<{ tab: PortalSocialTab; label: string }> = [
  { tab: "to_review", label: "To review" },
  { tab: "grid", label: "Grid preview" },
  { tab: "approved", label: "Approved" },
];

/** To review (the default), Grid preview and Approved: links, the portal's own sub-tab look. */
export function PortalSocialTabs({ q }: { q: SocialQuery }) {
  return (
    <nav className="ps-tabs" aria-label="Post groups">
      {TABS.map((t) => (
        <Link key={t.tab} href={socialHref(q, { tab: t.tab, cursor: null, post: null })} className="cp-subtab" aria-current={t.tab === q.tab ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
