import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { readResult } from "@/lib/readResult";
import { getBillingProfile } from "@/lib/billingProfile-data";
import { Card, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { BankDetailsForm, BillingProfileForm } from "@/components/finance/BillingProfileForms";
import "@/components/billing/billing-screens.css";

// PV5-09 — the company's BILLING PROFILE (`/finance/settings/billing-profile`; BFF §30).
//
// Everything an issued invoice says about the issuer comes from here: legal name, address, the number prefix, payment
// terms, the account clients pay into, and the two ledger accounts behind it. Issuing an invoice freezes a copy, so editing
// this never changes an invoice already issued.
//
// ── THE READ REFUSES EXPLICITLY ───────────────────────────────────────────────────────────────────
// A refused or failed read is a `<ReadRefusal>`, never a blank form: showing empty fields for a profile that exists but
// could not be read would invite someone to save a blank profile over the real one. Only a 404 ("no profile yet") shows
// the create form.
//
// ── THE BANK ACCOUNT IS A SECTION OF ITS OWN ──────────────────────────────────────────────────────
// "Clients pay into this account", saved by its own button in its own request, masked by default, and gated by a fresh
// second factor (PV-D26): see `BillingProfileForms.tsx` and `lib/billingProfileActions.ts`.
//
// NPWP and PKP are not here. They live in Accounting settings (one source each), and Issue refuses a taxed invoice until
// Finance has recorded the PKP status.
export default async function BillingProfilePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const res = await readResult(getBillingProfile(userId, tenant));

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Billing profile</h1>
        <p className="fin-page__asof">
          How this company appears on the invoices it issues, and where clients pay. Tax identity (NPWP and PKP) is kept in{" "}
          <Link className="bs-link" href="/finance/settings">accounting settings</Link>.
        </p>
      </header>

      {res.kind !== "ok" ? (
        <ReadRefusal subject="this company's billing profile" kind={res.kind} reason={res.kind === "unavailable" ? res.reason : undefined} />
      ) : (
        <>
          {res.data === null && (
            <EmptyNote>
              This company has no billing profile yet, so no invoice can be issued. Fill in the details below to create it, then
              add the bank account.
            </EmptyNote>
          )}
          <Card title="Issuer details">
            <BillingProfileForm profile={res.data} />
            {res.data?.signatureThreshold && (
              <p className="bs-note" style={{ marginTop: 12 }}>
                Signature threshold on record: {res.data.signatureThreshold}. It is set by counsel&apos;s advice and is not edited here.
              </p>
            )}
          </Card>
          <Card>
            <BankDetailsForm bank={res.data?.bank ?? null} hasProfile={res.data !== null} assuranceHigh={me.assurance === "high"} />
          </Card>
        </>
      )}
    </div>
  );
}
