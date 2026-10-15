"use server";
// DW-7g-1 — the tax-return write path on Finance > Tax: prepare a period's return, record its filing, amend a filed one.
//
// Same `ctx()`/`send()` convention as `financeActions.ts` (session -> tenant -> platformFetch). A "use server" file may
// export only async functions and types, so the kinds and the wire shapes live in `taxReturns.ts`.
//
// ── THE SERVER IS THE BOUNDARY, THIS FILE ONLY PUTS ITS ANSWERS IN WORDS ────────────────────────────────────────
// `finance_tax` `prepare` (finance staff and manager roles) and `file` (finance manager, company_admin; high assurance)
// are Cerbos rules. A 403 is said as "You don't have permission to ...", or, when only the assurance tier stands in the
// way, as a second-factor refusal carrying the machine `reason` so the form can offer the (simulated, dev stage) step-up.
// A 400 or 409 carries the database's or the controller's own sentence ("PPN 2026-03 is already filed ...", "period ends
// 2026-10-31 — cannot file before it closes") and is passed through untouched: a second copy of those rules here is a
// second thing to drift, and tax is the last place for it.
//
// The only checks made here are the shape ones the server makes first, so a blank form never costs a round trip.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { isAssuranceRefusal } from "./stepUp";
import {
  isAnnualKind, isTaxReturnKind, TAX_RETURN_KINDS,
  type FiledTaxReturn, type PreparedTaxReturn,
} from "./taxReturns";
import type { FinanceActionResult } from "./financeActions";

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

async function post<T>(path: string, body: unknown, what: string): Promise<FinanceActionResult<T>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const result = await platformFetch<T>(`/api/${c.tenant}${path}`, c.userId, {
      method: "POST",
      body: JSON.stringify(body),
    });
    // Every figure on the screen is re-read from the server after a write; none is carried over from this answer.
    revalidatePath("/finance/tax");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 403) {
        return {
          ok: false,
          error: isAssuranceRefusal(e.reason)
            ? `You need a second factor before you can ${what}.`
            : `You don't have permission to ${what}.`,
          ...(e.reason ? { reason: e.reason } : {}),
        };
      }
      return { ok: false, error: e.message, ...(e.reason ? { reason: e.reason } : {}) };
    }
    throw e;
  }
}

/**
 * Prepare (or re-open) the return for one tax period: `POST finance/tax/returns`. Idempotent per tenant, kind, year and
 * month: asking again returns the same draft, never a second one, and `result.computed` is the live figure from the
 * ledger now (a draft stores none). A period already filed is the server's 409. `month` is ignored for the annual
 * `pph_badan` and required for every other kind.
 */
export async function prepareTaxReturn(
  kind: string,
  year: number,
  month?: number | null,
): Promise<FinanceActionResult<PreparedTaxReturn>> {
  if (!isTaxReturnKind(kind)) return { ok: false, error: `Choose a return kind: ${TAX_RETURN_KINDS.join(", ")}.` };
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return { ok: false, error: "The year must be between 2000 and 2100." };
  const body: { kind: string; periodYear: number; periodMonth?: number } = { kind, periodYear: year };
  if (!isAnnualKind(kind)) {
    if (month == null || !Number.isInteger(month) || month < 1 || month > 12) {
      return { ok: false, error: "Choose the month, 1 to 12. Only the annual PPh Badan return has no month." };
    }
    body.periodMonth = month;
  }
  return post("/finance/tax/returns", body, "prepare tax returns");
}

/**
 * Record that a return was lodged, or an amendment to one that was: `POST finance/tax/returns/:id/file`. This transmits
 * nothing (it goes through a licensed ASP/PJAP); it records the receipt and freezes the figures as the ledger computes
 * them now. `confirm` must be the period label exactly (`PPN 2026-03`), the server compares it. `amend: true` is needed
 * for a return that is already filed or amended, and refused for a draft.
 */
export async function fileTaxReturn(
  returnId: string,
  input: { filingReference: string; confirm: string; amend?: boolean },
): Promise<FinanceActionResult<FiledTaxReturn>> {
  if (!returnId) return { ok: false, error: "Choose a return to file." };
  const filingReference = (input.filingReference ?? "").trim();
  if (!filingReference) {
    return { ok: false, error: "Enter the filing reference: the NTPN or receipt from the tax channel is the evidence the return was lodged." };
  }
  if (!(input.confirm ?? "").trim()) return { ok: false, error: "Type the period to confirm." };
  return post(
    `/finance/tax/returns/${encodeURIComponent(returnId)}/file`,
    { filingReference, confirm: input.confirm, ...(input.amend ? { amend: true } : {}) },
    input.amend ? "amend a tax return" : "record a tax filing",
  );
}
