// FinanceErrorFilter — and specifically the NON-finance path, which is the dangerous one.
//
// This filter is `@Catch(DatabaseError)`, so it intercepts every pg error in the estate rather
// than only finance's. The first version answered a non-finance error itself, with the same body
// LastResortExceptionFilter uses. That was wrong in a way nothing could see: LastResort also
// writes `[unhandled-exception]` to stderr and records the fault on the active OTel span, so
// replying in its place turned every non-finance database fault into a SILENT 500 — identical
// response, no log line, no trace.
//
// The response-shape assertions below would have passed against that broken version. The one that
// matters is the LOG assertion.
import { describe, it, expect, vi, afterEach } from "vitest";
import { DatabaseError } from "pg";
import type { ArgumentsHost } from "@nestjs/common";
import { FinanceErrorFilter } from "./finance-error.filter";

interface Sent {
  status: number;
  body: unknown;
}

/** Minimal ArgumentsHost over a fake Fastify reply. */
function hostFor(sent: Sent[]): ArgumentsHost {
  const reply = {
    status(code: number) {
      return {
        send(body: unknown) {
          sent.push({ status: code, body });
        },
      };
    },
  };
  return {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => ({ method: "GET", url: "/api/test" }),
    }),
  } as unknown as ArgumentsHost;
}

function pgError(message: string, hint?: string): DatabaseError {
  const e = new DatabaseError(message, 0, "error");
  if (hint) (e as { hint?: string }).hint = hint;
  return e;
}

describe("FinanceErrorFilter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps an unbalanced journal to 400 with the database's own message", () => {
    const sent: Sent[] = [];
    new FinanceErrorFilter().catch(pgError("FINANCE_UNBALANCED: debits 100 <> credits 90"), hostFor(sent));
    expect(sent[0].status).toBe(400);
    expect(sent[0].body).toMatchObject({ error: "debits 100 <> credits 90", code: "finance_unbalanced" });
  });

  it("defaults an UNRECOGNISED FINANCE_* code to 409 rather than 500", () => {
    // A refusal added by a later migration must be mapped by construction — needing an edit here to
    // avoid a 500 is how the estate shipped this bug four times before.
    const sent: Sent[] = [];
    new FinanceErrorFilter().catch(pgError("FINANCE_SOMETHING_INVENTED: the books refuse"), hostFor(sent));
    expect(sent[0].status).toBe(409);
    expect(sent[0].body).toMatchObject({ error: "the books refuse", code: "finance_something_invented" });
  });

  it("carries the plpgsql HINT, because that is the actionable half of the message", () => {
    const sent: Sent[] = [];
    new FinanceErrorFilter().catch(
      pgError("FINANCE_PERIOD_LOCKED: 2026-01 is HARD_LOCK", "post a correcting entry in an open period"),
      hostFor(sent),
    );
    expect(sent[0].body).toMatchObject({
      error: "2026-01 is HARD_LOCK — post a correcting entry in an open period",
    });
  });

  it("★ a NON-finance database error is still LOGGED, not silently answered", () => {
    // The regression this file exists for. Both the old (broken) and new versions return 500 with
    // an identical body, so only the log line distinguishes them.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const sent: Sent[] = [];
    new FinanceErrorFilter().catch(pgError('relation "widgets" does not exist'), hostFor(sent));

    expect(sent[0].status).toBe(500);
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toContain("[unhandled-exception]");
  });

  it("a non-finance error never leaks the database's message to the client", () => {
    // A pg error can carry table names, column values and SQL. The finance family is safe to
    // surface because those messages are written by our own migrations; nothing else is.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sent: Sent[] = [];
    new FinanceErrorFilter().catch(pgError('duplicate key value violates unique constraint "users_email_key"'), hostFor(sent));
    expect(JSON.stringify(sent[0].body)).not.toContain("users_email_key");
  });
});
