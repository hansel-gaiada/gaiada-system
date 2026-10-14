"use client";
import { useActionState } from "react";
import { saveBankDetailsAction, saveBillingProfileAction } from "@/lib/billingProfileActions";
import type { BankBlock, BillingProfile, ProfileSaveResult } from "@/lib/billingProfile";
import { MaskedAccount } from "@/components/billing/MaskedAccount";
import "@/components/billing/billing-screens.css";

// PV5-09 — the two halves of the billing profile page.
//
// ── TWO FORMS, TWO SAVE BUTTONS, TWO PUTs ─────────────────────────────────────────────────────────────
// The bank account clients pay into is NOT a field of the profile form. Changing it redirects real money, so it is its own
// section, "Clients pay into this account", with its own button and its own request (`{ bank }` only): a different Cerbos
// action, a different set of people, a fresh second factor for everyone (PV-D26), and a notice to every owner. A single
// form with one Save would let an ordinary profile edit carry a bank change in with it, or fail the whole save on an
// assurance rule the person never saw coming.

function Message({ state }: { state: ProfileSaveResult | null }) {
  if (!state) return null;
  if (!state.ok && state.error) return <p className="bs-error" role="alert">{state.error}</p>;
  if (state.ok && state.notice) return <p className="bs-ok" role="status">{state.notice}</p>;
  return null;
}

function Field({ id, label, hint, wide, children }: { id: string; label: string; hint?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={`bs-field${wide ? " bs-field--wide" : ""}`}>
      <label className="bs-field__label" htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="bs-field__hint" id={`${id}-hint`}>{hint}</span>}
    </div>
  );
}

export function BillingProfileForm({ profile }: { profile: BillingProfile | null }) {
  const [state, formAction, pending] = useActionState<ProfileSaveResult | null, FormData>(saveBillingProfileAction, null);
  return (
    <form action={formAction} className="bs-form" aria-label="Billing profile">
      <div className="bs-grid">
        <Field id="bp-legal" label="Legal name" hint="Printed on every invoice as the issuer.">
          <input id="bp-legal" name="legalName" required defaultValue={profile?.legalName ?? ""} disabled={pending} autoComplete="organization" aria-describedby="bp-legal-hint" />
        </Field>
        <Field id="bp-prefix" label="Invoice number prefix" hint="Starts every invoice number, for example PREFIX/2026/10/CODE/0001. Capital letters, digits or a dash.">
          <input
            id="bp-prefix" name="invoicePrefix" required maxLength={16}
            defaultValue={profile?.invoicePrefix ?? ""} disabled={pending} aria-describedby="bp-prefix-hint"
          />
        </Field>
        <Field id="bp-address" label="Address" wide hint="Printed on every invoice under the legal name.">
          <textarea id="bp-address" name="address" required defaultValue={profile?.address ?? ""} disabled={pending} aria-describedby="bp-address-hint" />
        </Field>
        <Field id="bp-terms" label="Payment terms (days)" hint="How long a client has to pay, counted from the issue date. 0 to 365.">
          <input id="bp-terms" name="defaultPaymentTermsDays" type="number" min={0} max={365} step={1} required defaultValue={profile?.defaultPaymentTermsDays ?? 30} disabled={pending} aria-describedby="bp-terms-hint" />
        </Field>
        <Field id="bp-currency" label="Currency" hint="The books' currency, as a three-letter code.">
          <input id="bp-currency" name="currencyCode" required maxLength={3} defaultValue={profile?.currencyCode ?? ""} disabled={pending} aria-describedby="bp-currency-hint" />
        </Field>
        <Field id="bp-revenue" label="Revenue account code" hint="The ledger account issued invoices are credited to. Leave blank and Issue will say it is missing.">
          <input id="bp-revenue" name="defaultRevenueAccountCode" defaultValue={profile?.defaultRevenueAccountCode ?? ""} disabled={pending} aria-describedby="bp-revenue-hint" />
        </Field>
        <Field id="bp-bankledger" label="Receipt account code" hint="The ledger bank account a confirmed payment is received into.">
          <input id="bp-bankledger" name="bankLedgerAccountCode" defaultValue={profile?.bankLedgerAccountCode ?? ""} disabled={pending} aria-describedby="bp-bankledger-hint" />
        </Field>
        <Field id="bp-clearing" label="Online payment clearing account code" hint="Where a payment made online is booked until the payment provider pays it out to the bank. Leave blank and clients are not offered Pay online.">
          <input id="bp-clearing" name="gatewayClearingAccountCode" defaultValue={profile?.gatewayClearingAccountCode ?? ""} disabled={pending} aria-describedby="bp-clearing-hint" />
        </Field>
      </div>
      <div className="bs-actions">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? "Saving…" : profile ? "Save billing profile" : "Create billing profile"}
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function BankDetailsForm({ bank, hasProfile, assuranceHigh }: {
  bank: BankBlock | null;
  /** The bank account is part of the profile: it can only be saved once the profile exists (the server needs the legal
   *  name, address and prefix to create one). */
  hasProfile: boolean;
  /** From `/api/me`: is this session already at high assurance? Only changes what the page SAYS up front; the server
   *  decides, and a refusal sends the user through the step-up flow. */
  assuranceHigh: boolean;
}) {
  const [state, formAction, pending] = useActionState<ProfileSaveResult | null, FormData>(saveBankDetailsAction, null);
  // A new key after a save re-seeds the fields from the saved values (they are uncontrolled), and the number is never
  // pre-filled: it must be typed again, which is the point of a change that moves money.
  const formKey = `${bank?.bankName ?? ""}|${bank?.accountName ?? ""}|${bank?.accountNo ?? ""}`;
  return (
    <section className="bs-bank" aria-labelledby="bank-title">
      <h2 id="bank-title" className="bs-bank__title">Clients pay into this account</h2>
      <p className="bs-note">
        Printed on every invoice we issue and shown to clients under How to pay. Changing it needs a fresh second factor from
        whoever does it, and every owner of the company is told when it changes.
      </p>

      {bank ? (
        <dl className="bs-bank__current" aria-label="Current bank account">
          <dt>Bank</dt><dd>{bank.bankName}</dd>
          <dt>Account name</dt><dd>{bank.accountName}</dd>
          <dt>Account number</dt><dd><MaskedAccount value={bank.accountNo} /></dd>
        </dl>
      ) : (
        <p className="bs-note">No bank account is recorded yet, so an invoice cannot be issued.</p>
      )}

      {!assuranceHigh && (
        <p className="bs-note" role="note">
          Your sign-in is not at high assurance. When you save, you will be asked to verify with a second factor, then brought
          back to this page.
        </p>
      )}

      <form action={formAction} key={formKey} className="bs-form" aria-label="Change the bank account clients pay into">
        <div className="bs-grid">
          <Field id="bank-name" label="Bank">
            <input id="bank-name" name="bankName" required defaultValue={bank?.bankName ?? ""} disabled={pending || !hasProfile} autoComplete="off" />
          </Field>
          <Field id="bank-holder" label="Account name">
            <input id="bank-holder" name="accountName" required defaultValue={bank?.accountName ?? ""} disabled={pending || !hasProfile} autoComplete="off" />
          </Field>
          <Field id="bank-no" label="Account number" hint={bank ? "Type the full number again. It is not kept in this form." : undefined}>
            <input id="bank-no" name="accountNo" required inputMode="numeric" defaultValue="" disabled={pending || !hasProfile} autoComplete="off" aria-describedby={bank ? "bank-no-hint" : undefined} />
          </Field>
        </div>
        {!hasProfile && <p className="bs-note">Save the billing profile above first. The bank account is part of it.</p>}
        <div className="bs-actions">
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || !hasProfile}>
            {pending ? "Saving…" : "Save bank account"}
          </button>
        </div>
        <Message state={state} />
      </form>
    </section>
  );
}
