"use server";
// PV5-09 — the writes behind `/finance/settings/billing-profile` (BFF §30, `PUT /api/:t/billing-profile`). Two actions, two
// PUTs, on purpose:
//
//   saveBillingProfileAction  the issuer's name and address, the prefix, terms, currency and the two ledger codes. Never
//                             carries a `bank` key, so it needs only the ordinary `finance_config` update.
//   saveBankDetailsAction     ONLY `{ bank }`: the account clients pay into. A different Cerbos action
//                             (`set_bank_details`) with its own holders (an owner or finance manager, or the platform
//                             administrator) and HIGH ASSURANCE for everyone (PV-D26). It notifies every owner.
//
// ── THE STEP-UP PATH (PV-D26) ─────────────────────────────────────────────────────────────────────────
// A bank change from a session below high assurance is refused with a 403. The platform answers every Cerbos denial with
// the same 403 and no structured reason, so WHY is read from the one thing this layer knows: the caller's own assurance
// (`/api/me`). Below high, the user is sent through the existing step-up flow (`/step-up?return=<this page>`, the one the
// app already uses to ask for a stronger sign-in) and lands back here. At high, the role is what is missing, and sending
// them round the loop again would never end, so the refusal is said in words instead.
//
// The redirect is issued from the action itself, outside any `try`, because `redirect()` works by throwing.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { BILLING_PROFILE_PATH, profileBody, validateProfileForm, type ProfileSaveResult } from "./billingProfile";
import { classifyBankRefusal, stepUpHref, validateBank } from "./billingView";
import { isAssuranceRefusal } from "./stepUp";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

async function ctx(): Promise<{ userId: string; tenant: string; assurance: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session has expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant, assurance: me.assurance };
}

export async function saveBillingProfileAction(_prev: ProfileSaveResult | null, formData: FormData): Promise<ProfileSaveResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const values = {
    legalName: str(formData, "legalName"),
    address: str(formData, "address"),
    invoicePrefix: str(formData, "invoicePrefix").toUpperCase(),
    defaultPaymentTermsDays: str(formData, "defaultPaymentTermsDays"),
    currencyCode: str(formData, "currencyCode"),
    bankLedgerAccountCode: str(formData, "bankLedgerAccountCode"),
    defaultRevenueAccountCode: str(formData, "defaultRevenueAccountCode"),
  };
  const bad = validateProfileForm(values);
  if (bad) return { ok: false, error: bad.message, field: bad.field };
  try {
    await platformFetch(`/api/${c.tenant}/billing-profile`, c.userId, { method: "PUT", body: JSON.stringify(profileBody(values)) });
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 403) return { ok: false, error: "Changing the billing profile is limited to finance managers and company administrators." };
      return { ok: false, error: e.message, ...(e.field ? { field: e.field } : {}) };
    }
    throw e;
  }
  revalidatePath(BILLING_PROFILE_PATH);
  return { ok: true, notice: "Saved. Invoices issued from now on use these details; invoices already issued keep theirs." };
}

export async function saveBankDetailsAction(_prev: ProfileSaveResult | null, formData: FormData): Promise<ProfileSaveResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const bank = { bankName: str(formData, "bankName"), accountName: str(formData, "accountName"), accountNo: str(formData, "accountNo") };
  const bad = validateBank(bank);
  if (bad) return { ok: false, error: bad.message, field: bad.field };

  let stepUp = false;
  try {
    // ONLY the bank key: it is its own authorization, and a body with nothing else needs nothing else.
    await platformFetch(`/api/${c.tenant}/billing-profile`, c.userId, { method: "PUT", body: JSON.stringify({ bank }) });
  } catch (e) {
    if (!(e instanceof PlatformError)) throw e;
    if (e.status === 403) {
      // PV5-14: the platform now NAMES an assurance refusal (`reason: "assurance_required"`, while the simulated
      // second factor is switched on); the caller's own assurance stays the fallback for a server that does not.
      if (isAssuranceRefusal(e.reason) || classifyBankRefusal(c.assurance) === "step_up") stepUp = true;
      else return { ok: false, error: "Only an owner or a finance manager of this company, or the platform administrator, can change the bank account clients pay into." };
    } else if (e.status === 404) {
      return { ok: false, error: "Save the billing profile first. The bank account is part of it." };
    } else {
      return { ok: false, error: e.message, ...(e.field ? { field: e.field } : {}) };
    }
  }
  if (stepUp) redirect(stepUpHref(BILLING_PROFILE_PATH));
  revalidatePath(BILLING_PROFILE_PATH);
  return { ok: true, notice: "Saved. Every owner of this company has been told the bank account changed." };
}
