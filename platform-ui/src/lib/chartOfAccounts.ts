// DW-7g-2: the chart of accounts' write side on Finance > Chart of accounts. Plain module (no "use server", no "server-only"):
// the wire shapes of `POST/PATCH finance/accounts[/:code]`, `POST .../archive` and `.../restore` (BFF §49), the constants the
// action and the screen share, and the few pure rules. A "use server" file may export only async functions and types, so
// none of this can live in `financeAccountActions.ts`.
import type { Me } from "./platform";
import { can, isElevated } from "./rbac";
import type { AccountType, NormalBalance } from "./finance";

export const ACCOUNT_TYPES: ReadonlyArray<{ type: AccountType; label: string }> = [
  { type: "asset", label: "Asset" },
  { type: "liability", label: "Liability" },
  { type: "equity", label: "Equity" },
  { type: "revenue", label: "Revenue" },
  { type: "expense", label: "Expense" },
];
export const isAccountType = (t: string): t is AccountType => ACCOUNT_TYPES.some((x) => x.type === t);

/** §49.2: 1-20 characters of `A-Z a-z 0-9 . -`. The server decides; this only saves a round trip for a blank or bad code. */
export const ACCOUNT_CODE_PATTERN = /^[A-Za-z0-9.-]{1,20}$/;
export const ACCOUNT_NAME_MAX = 120;
export const ACCOUNT_DESCRIPTION_MAX = 500;

/** §49.2: asset and expense accounts carry a debit normal balance, the rest credit. A contra account overrides it. */
export const defaultNormalBalance = (t: AccountType): NormalBalance => (t === "asset" || t === "expense" ? "debit" : "credit");

/** The wire shape of what the four routes accept. */
export interface NewAccountInput {
  code: string;
  name: string;
  accountType: AccountType;
  normalBalance?: NormalBalance;
  parentCode?: string | null;
  isPostable?: boolean;
  currencyCode?: string | null;
  description?: string | null;
}
export interface AccountEditInput {
  name?: string;
  /** `null` clears it. */
  description?: string | null;
  /** Only while the account has no postings; the freeze trigger refuses otherwise (409 `account_frozen`). */
  newCode?: string;
  parentCode?: string | null;
}

/** One entry of a 409 `account_in_use`: a table that still points at the account for new postings. */
export interface AccountUsedBy { table: string; count: number }

/**
 * The answer of every chart action. `error` is the server's own sentence, passed through, or a 403 said in words. `reason`
 * is the machine code (`code_taken`, `account_frozen`, `account_has_balance`, `account_has_children`, `account_is_control`,
 * `account_in_use`, `parent_archived`, ...), `field` names the input a 400 is about, and `usedBy` is present on
 * `account_in_use`. Nothing here is guessed: each is what the server returned.
 */
export type ChartActionResult<T = undefined> = {
  ok: boolean;
  error?: string;
  reason?: string;
  field?: string;
  usedBy?: AccountUsedBy[];
  hint?: string;
  result?: T;
};

/** The tables that can hold an account, in the words a finance user knows them by. An unknown table keeps its own name. */
export const USED_BY_LABEL: Record<string, string> = {
  finance_posting_rules: "posting rules",
  finance_tax_codes: "tax codes",
  finance_asset_classes: "fixed-asset classes",
  finance_instruments: "loans and instruments",
  company_billing_profiles: "the billing profile (bank or revenue account)",
};

/** `account_in_use`'s list as one sentence fragment: `posting rules (2), tax codes (1)`. */
export function usedByWords(usedBy: ReadonlyArray<AccountUsedBy>): string {
  return usedBy.map((u) => `${USED_BY_LABEL[u.table] ?? u.table} (${u.count})`).join(", ");
}

/**
 * Whether to offer New account, Rename and Archive or Restore at all. COSMETIC: the server decides (Cerbos `finance_config`
 * `create`/`update`: the finance manager role, company_admin and the platform operator). `lib/rbac.ts` has no capability
 * for it, so this is a SUPERSET of the people the server allows: `company.manage` or an elevated role, or a
 * `finance_manager` grant that covers the company. Someone it shows a control to may still be refused, in words.
 */
export function canEditChart(me: Me, tenant: string): boolean {
  if (isElevated(me) || can(me, "company.manage", tenant)) return true;
  return me.roles.some(
    (g) => g.role === "finance_manager" && (g.scopeType === "global" || (g.scopeType === "company" && g.scopeId === tenant)),
  );
}
