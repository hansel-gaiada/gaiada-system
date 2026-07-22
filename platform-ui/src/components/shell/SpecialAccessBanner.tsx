// Shown to view-all / unrestricted accounts (owner, superadmin, holding head-of-
// department). Their whole session is "special access" across companies, so this
// compliance strip makes clear it's monitored — sits at the top of every page.
export function SpecialAccessBanner({ unrestricted }: { unrestricted: boolean }) {
  return (
    <div className="erp-special" role="note">
      <span className="erp-special__tag">{unrestricted ? "Unrestricted access" : "Elevated access"}</span>
      <span className="erp-special__text">
        You can view {unrestricted ? "and change" : ""} every company under the holding. This is special
        access — all actions are <strong>monitored, logged, and reported</strong>.
      </span>
    </div>
  );
}
