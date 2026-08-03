// Shown to unrestricted accounts (owner, superadmin). Their whole session is
// "special access" across companies, so this compliance strip makes clear
// it's monitored — sits at the top of every page. (The narrower "view-all but
// not unrestricted" tier, formerly `holding_head`, was removed per the
// backbone-program A4 amendment — see lib/rbac.ts `canViewAllCompanies`; the
// `unrestricted` prop is currently always true when this banner renders, kept
// as a prop rather than inlined in case a future non-unrestricted view-all
// grant reappears via a different mechanism.)
export function SpecialAccessBanner({ unrestricted }: { unrestricted: boolean }) {
  return (
    <div className="erp-special" role="note">
      <span className="erp-special__tag">{unrestricted ? "Unrestricted access" : "Elevated access"}</span>
      {/* Kept to one line: it appears on every page of every session for these accounts, so the
          long form was three lines of repetition a day. The two facts that must land — the scope
          of the access, and that it is recorded — both survive. */}
      <span className="erp-special__text">
        Every company{unrestricted ? ", editable" : ""} — actions are <strong>logged and reported</strong>.
      </span>
    </div>
  );
}
