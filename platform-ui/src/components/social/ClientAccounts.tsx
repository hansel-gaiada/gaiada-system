"use client";
// SCP-Sb (plan §5; BFF §63.1 file 8): the client page's social accounts line. It lists the client's accounts, each SIMULATED one marked and the sentence said once,
// and, for the four approvers, offers "Seed simulated accounts" when the client lacks an Instagram, Facebook or TikTok account (`POST
// engagements/:engagementId/simulated-accounts`; idempotent). The button is not hidden by role: the server's 403 is the boundary and is shown in words, as is its 409
// while the simulator is switched off on the server. A failed or refused READ is said as such, never drawn as "no accounts".
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { SimulatedAccountChip } from "./SimulatedAccountChip";
import "@/components/social/simulated-account.css";
import { seedSimulatedAccounts } from "@/lib/socialSimulatedAccountsActions";
import { networksMissingAccount } from "@/lib/socialSimulatedAccounts";
import { NETWORK_LABEL } from "@/lib/socialAllocation";
import { SIMULATED_ACCOUNT_NOTE, type SocialAccount } from "@/lib/socialShared";

export type ClientAccountsRead = { kind: "ok"; accounts: readonly SocialAccount[] } | { kind: "forbidden" } | { kind: "unavailable" };

export function ClientAccounts({ engagementId, read, canPlan }: { engagementId: string; read: ClientAccountsRead; canPlan: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function seed() {
    setError(null);
    setDone(null);
    start(async () => {
      const r = await seedSimulatedAccounts(engagementId);
      if (!r.ok) { setError(r.message); return; }
      const added = r.accounts.filter((a) => a.created).length;
      const off = r.accounts.filter((a) => !a.networkEnabled).map((a) => NETWORK_LABEL[a.network] ?? a.network);
      setDone(
        `${added === 0 ? "The simulated accounts were already there." : `Seeded ${added} simulated account${added === 1 ? "" : "s"}.`}`
        + (off.length > 0 ? ` ${off.join(", ")} cannot publish until the server's SOCIAL_NETWORKS_ENABLED names ${off.length === 1 ? "it" : "them"}.` : ""),
      );
      router.refresh();
    });
  }

  const accounts = read.kind === "ok" ? read.accounts : [];
  const missing = read.kind === "ok" ? networksMissingAccount(accounts) : [];
  return (
    <section className="scp-accts" aria-label="Social accounts">
      <h3 className="scp-accts__title">Social accounts</h3>
      {read.kind === "forbidden" ? (
        <p className="scp-note">Reading this client&apos;s accounts needs a Social Media read tier.</p>
      ) : read.kind === "unavailable" ? (
        <p className="scp-note">This client&apos;s accounts could not be read just now.</p>
      ) : accounts.length === 0 ? (
        <p className="scp-note">No social accounts yet.</p>
      ) : (
        <ul className="scp-accts__list">
          {accounts.map((a) => (
            <li key={a.id} className="scp-accts__item">
              <b>{NETWORK_LABEL[a.network] ?? a.network}</b>
              <span className="scp-accts__handle">{a.handle}</span>
              {a.simulated && <SimulatedAccountChip />}
            </li>
          ))}
        </ul>
      )}
      {accounts.some((a) => a.simulated) && <p className="scp-note">{SIMULATED_ACCOUNT_NOTE}</p>}
      {read.kind === "ok" && missing.length > 0 && canPlan && (
        <div className="scp-accts__row">
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={seed} disabled={pending}>
            {pending ? "Seeding…" : "Seed simulated accounts"}
          </button>
          <span className="scp-note">
            Adds a simulated {missing.map((n) => NETWORK_LABEL[n] ?? n).join(", ")} account{missing.length === 1 ? "" : "s"}, for the dev review only.
          </span>
        </div>
      )}
      {done && <p className="scp-msg scp-msg--ok" role="status">{done}</p>}
      {error && <p className="scp-msg scp-msg--error" role="alert">{error}</p>}
    </section>
  );
}
