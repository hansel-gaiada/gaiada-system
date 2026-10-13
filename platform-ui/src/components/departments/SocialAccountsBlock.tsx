import { StatusBadge } from "@/components/ui";
import type { SocialAccount } from "@/lib/socialShared";

// DW-6c: the social accounts block of the pilot's Connections section. Read-only: the backend's
// account-connect (SMM-07) is built, but the ERP has no connect control yet. `accounts: null` means
// the read failed, which says "unavailable", never "none".
export function SocialAccountsBlock({ accounts, forbidden = false }: { accounts: readonly SocialAccount[] | null; forbidden?: boolean }) {
  if (accounts === null || forbidden) {
    return <p className="dept-conn-note">Social accounts are unavailable right now, so their status can&apos;t be shown.</p>;
  }
  return (
    <>
      {accounts.length === 0 ? (
        <p className="dept-conn-note">No social accounts are connected yet.</p>
      ) : (
        <ul className="dept-conn-list">
          {accounts.map((a) => (
            <li key={a.id} className="dept-conn-row">
              <div className="dept-conn-row__main">
                <span className="dept-conn-row__label">{a.network}</span>
                <span className="dept-conn-row__account">{a.handle}</span>
                <StatusBadge label={a.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="dept-conn-note" style={{ marginTop: 8 }}>Connecting an account from the ERP is not built yet.</p>
    </>
  );
}
