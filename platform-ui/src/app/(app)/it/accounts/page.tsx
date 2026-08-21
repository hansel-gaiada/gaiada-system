import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { canManageIT } from "@/components/shell/nav";
import { listAccounts, sortByUrgency, summarize, STATE_LABEL, STATE_HINT, type AccountState } from "@/lib/it-accounts";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { AccountActions } from "@/components/it/AccountActions";
import { provisionAccount, disableAccount, enableAccount, resetAccountPassword } from "./actions";
import "@/components/it/it.css";

// P2-14 — the IT accounts console (design §5.4). Backend: P2-13.
//
// ⚠ THE ONE THING THIS PAGE MUST NEVER DO is render "cannot see the identity provider" the same way as
// "no findings". An empty worklist asserts that everyone has a login; the backend refuses with a 503
// rather than making that claim while blind, `lib/it-accounts.ts` keeps the refusal as a discriminated
// `unavailable` result instead of degrading to `[]`, and this page renders it as a warning. Three layers
// all saying the same thing on purpose, because the failure is silent and reassuring.
//
// `actionable` and `state` are computed SERVER-side and used as given. Re-deriving "needs attention"
// here would be a second implementation that drifts, and the direction it drifts in is a leaver the
// console quietly stops flagging.

type SearchParams = Promise<{ all?: string }>;

const STATE_CLASS: Record<AccountState, string> = {
  leaver_still_enabled: "acct-state acct-state--finding",
  missing: "acct-state acct-state--todo",
  unverified_link: "acct-state acct-state--todo",
  disabled: "acct-state acct-state--todo",
  enabled: "acct-state acct-state--ok",
};

export default async function ItAccountsPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { all } = await searchParams;

  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const result = await listAccounts(userId, tenant);

  // Both branches now render through the shared `ReadRefusal` (plan action item 4) instead of this
  // page's own prose. The wording it carries is this page's wording, generalised — the "this is not a
  // statement that there is nothing here" sentence originated here and is the whole point of the
  // component, so nothing was softened in the move.
  if (result.kind === "forbidden") {
    return <ReadRefusal subject="account provisioning for this company" kind="forbidden" />;
  }

  if (result.kind === "unavailable") {
    return (
      <ReadRefusal
        subject="The account worklist"
        kind="unavailable"
        reason={result.reason}
        detail="An empty worklist would assert that everyone already has a login; that claim cannot be made while the identity provider is unreadable."
      />
    );
  }

  const canManage = canManageIT(me, tenant);
  const rows = sortByUrgency(result.accounts);
  const s = summarize(rows);
  // Default to the work: an operator opens this page to fix something, and a full staff list buries the
  // three rows that need them. `?all=1` shows everyone.
  const shown = all ? rows : rows.filter((r) => r.actionable);

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 20 }}>
        <KpiTile label="Staff" value={String(s.total)} foot="with an active membership" />
        <KpiTile label="Needs action" value={String(s.actionable)} />
        <KpiTile label="No login" value={String(s.missing)} />
        <KpiTile label="Leavers still enabled" value={String(s.leaversStillEnabled)} foot="security finding" />
        <KpiTile label="Unverified links" value={String(s.unverified)} />
      </div>

      <Card
        title={all ? "All staff accounts" : "Accounts needing action"}
        headerRight={
          <a
            href={all ? "/it/accounts" : "/it/accounts?all=1"}
            className="lux-btn lux-btn--ghost lux-btn--sm"
            style={{ textDecoration: "none" }}
          >
            {all ? "Show only what needs action" : `Show all ${s.total}`}
          </a>
        }
      >
        {shown.length === 0 ? (
          <EmptyNote>
            {all
              ? "No staff members with an active membership in this company."
              : "Nothing needs action — every staff member has an enabled, verified login."}
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Person" },
              { label: "State" },
              { label: "Employment" },
              { label: canManage ? "Actions" : "" },
            ]}
            rows={shown.map((r) => [
              <span key="p" style={{ display: "grid", gap: 2 }}>
                <span style={{ font: "400 13px var(--font-body)", color: "var(--text-primary)" }}>{r.name}</span>
                <span style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)" }}>{r.email}</span>
              </span>,
              <span key="s" style={{ display: "grid", gap: 2 }}>
                <span className={STATE_CLASS[r.state]}>{STATE_LABEL[r.state]}</span>
                <span style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)", maxWidth: "38ch" }}>
                  {STATE_HINT[r.state]}
                </span>
              </span>,
              // `null` means the HR module is off for this company, so employment status is unknown —
              // shown as "—" rather than guessed as active, matching the backend's own refusal to claim
              // `leaver_still_enabled` without real data.
              r.employmentStatus ?? "—",
              canManage ? (
                <AccountActions
                  key="a"
                  userId={r.userId}
                  email={r.email}
                  state={r.state}
                  provision={provisionAccount}
                  disable={disableAccount}
                  enable={enableAccount}
                  resetPassword={resetAccountPassword}
                />
              ) : (
                ""
              ),
            ])}
            tcols="1.4fr 1.6fr 0.7fr 1.6fr"
          />
        )}
      </Card>
    </>
  );
}
