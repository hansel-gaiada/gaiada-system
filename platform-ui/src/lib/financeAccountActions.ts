"use server";
// DW-7g-2 — the chart-of-accounts write path on Finance > Chart of accounts: add, rename, archive and restore an account.
//
// Same `ctx()`/`send()` convention as `financeTaxActions.ts` (session -> tenant -> platformFetch). A "use server" file may
// export only async functions and types, so the shapes, the constants and the pure rules live in `chartOfAccounts.ts`.
//
// ── THE SERVER IS THE BOUNDARY, THIS FILE ONLY PUTS ITS ANSWERS IN WORDS ────────────────────────────────────────
// `finance_config` `create` (a new account) and `update` (everything else) are Cerbos rules: the finance manager role,
// company_admin and the platform operator. A 403 is said as "You don't have permission to ...". A 400 or 409 carries the
// controller's own sentence ("account code 4910 is already used ...", "1120 (Bank) still holds a balance ...") and is passed
// through untouched, together with its machine `reason`, the `field` a 400 names and, on `account_in_use`, the `usedBy`
// list: a second copy of those rules here is a second thing to drift, and the chart is the last place for it.
//
// The only checks made here are the shape ones the server makes first, so a blank form never costs a round trip.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import {
  ACCOUNT_CODE_PATTERN, ACCOUNT_DESCRIPTION_MAX, ACCOUNT_NAME_MAX, isAccountType,
  type AccountEditInput, type AccountUsedBy, type ChartActionResult, type NewAccountInput,
} from "./chartOfAccounts";

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

/** `usedBy` rides the raw body of the 409 (`PlatformError.body`); read only what is the right shape. */
function usedByOf(body: unknown): AccountUsedBy[] | undefined {
  const raw = (body as { usedBy?: unknown } | null | undefined)?.usedBy;
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter(
    (u): u is AccountUsedBy => !!u && typeof (u as AccountUsedBy).table === "string" && typeof (u as AccountUsedBy).count === "number",
  );
  return out.length > 0 ? out : undefined;
}
const hintOf = (body: unknown): string | undefined => {
  const h = (body as { hint?: unknown } | null | undefined)?.hint;
  return typeof h === "string" && h ? h : undefined;
};

async function send<T>(method: "POST" | "PATCH", path: string, body: unknown | undefined, what: string): Promise<ChartActionResult<T>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const result = await platformFetch<T>(`/api/${c.tenant}${path}`, c.userId, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Every row on the screen is re-read from the server after a write; none is carried over from this answer. The journal
    // forms pick their accounts from the same list.
    revalidatePath("/finance/accounts");
    revalidatePath("/finance/journals");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 403) {
        return { ok: false, error: `You don't have permission to ${what}.`, ...(e.reason ? { reason: e.reason } : {}) };
      }
      const usedBy = usedByOf(e.body);
      const hint = hintOf(e.body);
      return {
        ok: false,
        error: e.message,
        ...(e.reason ? { reason: e.reason } : {}),
        ...(e.field ? { field: e.field } : {}),
        ...(usedBy ? { usedBy } : {}),
        ...(hint ? { hint } : {}),
      };
    }
    throw e;
  }
}

const codeWords = "The code is 1 to 20 characters: letters, digits, '.' or '-'.";

/** Add an account: `POST finance/accounts` -> 201 `{code}`. Control accounts are not created here (§49.2). */
export async function addAccount(input: NewAccountInput): Promise<ChartActionResult<{ code: string }>> {
  const code = (input.code ?? "").trim();
  if (!ACCOUNT_CODE_PATTERN.test(code)) return { ok: false, error: codeWords, field: "code" };
  const name = (input.name ?? "").trim();
  if (!name) return { ok: false, error: "Enter the account name.", field: "name" };
  if (name.length > ACCOUNT_NAME_MAX) return { ok: false, error: `The name is at most ${ACCOUNT_NAME_MAX} characters.`, field: "name" };
  if (!isAccountType(input.accountType)) return { ok: false, error: "Choose the account type.", field: "accountType" };
  const description = (input.description ?? "").trim();
  if (description.length > ACCOUNT_DESCRIPTION_MAX) {
    return { ok: false, error: `The description is at most ${ACCOUNT_DESCRIPTION_MAX} characters.`, field: "description" };
  }
  const currency = (input.currencyCode ?? "").trim();
  if (currency && !/^[A-Za-z]{3}$/.test(currency)) return { ok: false, error: "The currency is three letters, such as IDR.", field: "currencyCode" };
  const parent = (input.parentCode ?? "").trim();
  return send("POST", "/finance/accounts", {
    code, name, accountType: input.accountType,
    ...(input.normalBalance ? { normalBalance: input.normalBalance } : {}),
    ...(parent ? { parentCode: parent } : {}),
    ...(input.isPostable === undefined ? {} : { isPostable: input.isPostable }),
    ...(currency ? { currencyCode: currency.toUpperCase() } : {}),
    ...(description ? { description } : {}),
  }, "add accounts");
}

/**
 * Rename or re-describe an account, and re-code or re-parent it: `PATCH finance/accounts/:code` -> 200 `{code}`. Only the
 * fields sent change. `newCode` is refused by the database once the account has postings (409 `account_frozen`, with its
 * hint), and that sentence is passed through; the screen locks the field then, but the server is what decides.
 */
export async function editAccount(code: string, input: AccountEditInput): Promise<ChartActionResult<{ code: string }>> {
  if (!code) return { ok: false, error: "Choose an account." };
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { ok: false, error: "Enter the account name.", field: "name" };
    if (name.length > ACCOUNT_NAME_MAX) return { ok: false, error: `The name is at most ${ACCOUNT_NAME_MAX} characters.`, field: "name" };
    body.name = name;
  }
  if (input.description !== undefined) {
    const d = (input.description ?? "").trim();
    if (d.length > ACCOUNT_DESCRIPTION_MAX) {
      return { ok: false, error: `The description is at most ${ACCOUNT_DESCRIPTION_MAX} characters.`, field: "description" };
    }
    body.description = d || null;
  }
  if (input.newCode !== undefined) {
    const n = input.newCode.trim();
    if (!ACCOUNT_CODE_PATTERN.test(n)) return { ok: false, error: codeWords, field: "newCode" };
    body.newCode = n;
  }
  if (input.parentCode !== undefined) body.parentCode = input.parentCode === null || input.parentCode.trim() === "" ? null : input.parentCode.trim();
  if (Object.keys(body).length === 0) return { ok: false, error: "Nothing to change." };
  return send("PATCH", `/finance/accounts/${encodeURIComponent(code)}`, body, "edit accounts");
}

/**
 * Archive an account: `POST finance/accounts/:code/archive` -> 200 `{code, status: "archived"}`. The account then refuses
 * new postings and its history stays. Refused with 409 and a reason: `account_has_balance`, `account_has_children`,
 * `account_is_control`, or `account_in_use` (with `usedBy`). Each sentence is the server's, passed through.
 */
export async function archiveAccount(code: string): Promise<ChartActionResult<{ code: string; status: string }>> {
  if (!code) return { ok: false, error: "Choose an account." };
  return send("POST", `/finance/accounts/${encodeURIComponent(code)}/archive`, undefined, "archive accounts");
}

/** Restore an archived account: `POST finance/accounts/:code/restore`. Refused (409 `parent_archived`) while its parent is archived. */
export async function restoreAccount(code: string): Promise<ChartActionResult<{ code: string; status: string }>> {
  if (!code) return { ok: false, error: "Choose an account." };
  return send("POST", `/finance/accounts/${encodeURIComponent(code)}/restore`, undefined, "restore accounts");
}
