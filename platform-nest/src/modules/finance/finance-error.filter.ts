// Maps the FINANCE_* refusal family onto HTTP.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
// The finance foundation enforces its invariants in the DATABASE — balance, immutability, period
// locks, control-account rules, subledger limits. Those raise plpgsql exceptions, which arrive in
// Nest as `pg`'s `DatabaseError`: an `Error` subclass, not an `HttpException`. `HttpErrorFilter`
// (`@Catch(HttpException)`) never sees them, so every one fell through to
// `LastResortExceptionFilter` and answered an unconditional
// `500 { error: "internal error", code: "internal_error" }`.
//
// The user-facing consequence is the point: an accountant posting an unbalanced journal — the most
// common mistake in bookkeeping — got **"internal error"** instead of "debits 100 ≠ credits 90".
// The database had already computed the exact, useful message and the transport threw it away.
//
// ⚠ This is the FIFTH time this estate has shipped this bug. `client-access-error.filter.ts`'s own
// header counts four: SM-53 (ProviderDispatchError), SM-57 (GatewayNotConfiguredError), the Google
// OAuth family, and the Keycloak/invite family. Caught here by an API test that asserted on the
// message rather than only on a status code — which is the cheap way to keep finding it.
//
// ── WHY 409 AND NOT 400 FOR MOST OF THESE ───────────────────────────────────────────────────────
// The split is between "your request is malformed" and "your request is well-formed and the books
// refuse it". A journal with a negative amount is the first. Posting into a hard-locked period is
// the second — the request is perfectly valid and the state says no, which is what 409 means. That
// distinction matters to a UI: a 400 tells the user to fix their input, a 409 tells them the world
// changed under them and points at the reason.
//
// ── ONE FAMILY, MAPPED BY PREFIX, NOT A LIST TO MAINTAIN ────────────────────────────────────────
// Adding `FINANCE_SOMETHING_NEW` to a migration must not require editing this file to avoid a 500.
// So the DEFAULT for an unrecognised `FINANCE_*` code is 409 with its own message, and the tables
// below only override that where 400 is more honest. A new refusal is mapped by construction.
import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { DatabaseError } from "pg";
import { LastResortExceptionFilter } from "../../last-resort-exception.filter";

/** Codes where the CALLER's input is malformed — the user should change what they sent. */
const BAD_REQUEST = new Set([
  "FINANCE_EMPTY_JOURNAL",
  "FINANCE_BAD_SIDE",
  "FINANCE_BAD_AMOUNT",
  "FINANCE_UNBALANCED",
  "FINANCE_UNKNOWN_ACCOUNT",
  "FINANCE_UNKNOWN_DIMENSION",
  "FINANCE_UNKNOWN_DIMENSION_VALUE",
  "FINANCE_NO_CURRENCY",
  "FINANCE_REVERSAL_REASON_REQUIRED",
  "FINANCE_PAYLOAD_MISSING_PATH",
  "FINANCE_PAYLOAD_NOT_NUMERIC",
  "FINANCE_GRAIN_UNKNOWN",
  "FINANCE_AR_BAD_ALLOCATION",
  "FINANCE_AP_BAD_ALLOCATION",
]);

/** Codes naming something that does not exist. */
const NOT_FOUND = new Set([
  "FINANCE_UNKNOWN_JOURNAL",
  "FINANCE_UNKNOWN_PERIOD",
  "FINANCE_FY_UNKNOWN",
  "FINANCE_TEMPLATE_UNKNOWN",
  "FINANCE_EVENT_UNKNOWN",
  "FINANCE_AR_UNKNOWN_INVOICE",
  "FINANCE_AR_UNKNOWN_RECEIPT",
  "FINANCE_AP_UNKNOWN_BILL",
  "FINANCE_AP_UNKNOWN_PAYMENT",
  "FINANCE_BANK_UNKNOWN_STATEMENT",
]);

/** `FINANCE_XXX: message` — the shape every RAISE EXCEPTION in the finance migrations uses. */
const FINANCE_CODE = /^(FINANCE_[A-Z0-9_]+):\s*(.*)$/s;

function parse(err: unknown): { code: string; message: string; hint?: string } | null {
  const raw = (err as { message?: unknown })?.message;
  if (typeof raw !== "string") return null;
  const m = FINANCE_CODE.exec(raw);
  if (!m) return null;
  // pg carries the plpgsql HINT separately, and the finance migrations use it to say what to do
  // instead ("post a correcting entry in an open period"). Dropping it would discard the half of
  // the message that is actionable.
  const hint = (err as { hint?: unknown })?.hint;
  return { code: m[1], message: m[2].trim(), hint: typeof hint === "string" ? hint : undefined };
}

// ⚠ SCOPED TO `DatabaseError`, NOT a bare `@Catch()`.
//
// The first draft used `@Catch()` with a re-throw for anything unrecognised, and it broke the
// controller's own validation: a malformed date raised `BadRequestException`, this filter caught it
// first, and re-throwing from inside a filter does NOT hand the error to the next filter — Nest has
// already left the chain. The 400 came back in Nest's default `{statusCode, message, error}` shape
// instead of this estate's `{ error }` convention, which the UI and the bot both read.
//
// Catching the pg error class specifically means HttpExceptions never reach here at all.
/** One shared instance: the filter is stateless, and constructing one per fault would be noise. */
const LAST_RESORT = new LastResortExceptionFilter();

@Catch(DatabaseError)
export class FinanceErrorFilter implements ExceptionFilter {
  catch(exception: DatabaseError, host: ArgumentsHost) {
    const parsed = parse(exception);
    if (!parsed) {
      // ── A NON-FINANCE DATABASE ERROR: HAND IT BACK, DO NOT ANSWER IT HERE ───────────────────
      // This filter is `@Catch(DatabaseError)`, so it intercepts EVERY pg error in the estate, not
      // only finance's. Re-throwing does not work — Nest has already left the filter chain — so
      // the first version simply replied 500 with the same body LastResortExceptionFilter uses.
      //
      // That was wrong in a way that is invisible by construction: LastResort also writes
      // `[unhandled-exception]` to stderr AND records the fault on the active OTel span. Answering
      // in its place made every non-finance database fault a SILENT 500 — the response looked
      // identical while the log line and the trace disappeared.
      //
      // Delegating keeps ONE implementation of "what do we do with an unhandled fault", so a later
      // change there (a new status table, a different log tag) cannot drift from a copy hiding in
      // the finance module.
      LAST_RESORT.catch(exception, host);
      return;
    }

    const status = BAD_REQUEST.has(parsed.code) ? 400 : NOT_FOUND.has(parsed.code) ? 404 : 409;
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    // `error` is the field the UI and the bot read (main.ts's error-body convention). The code is
    // carried separately so a client can branch without string-matching a human message.
    void reply.status(status).send({
      error: parsed.hint ? `${parsed.message} — ${parsed.hint}` : parsed.message,
      code: parsed.code.toLowerCase(),
    });
  }
}
