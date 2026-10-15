// DW-7g-2 (BFF §49.4): HttpErrorFilter forwards `usedBy` and `hint` the way it forwards `reason` and `detail`. Without the
// forward the reshape to `{error}` silently drops them (the trap this filter's header describes), and the screen could not
// say which tables still use an account, or what the database advised for a frozen one.
import { describe, it, expect } from "vitest";
import { ConflictException, type ArgumentsHost } from "@nestjs/common";
import { HttpErrorFilter } from "./http-error.filter";

function run(ex: ConflictException): { status: number; body: Record<string, unknown> } {
  let out: { status: number; body: Record<string, unknown> } | undefined;
  const reply = { header: () => undefined, status: (s: number) => ({ send: (b: Record<string, unknown>) => { out = { status: s, body: b }; } }) };
  const host = { switchToHttp: () => ({ getResponse: () => reply }) } as unknown as ArgumentsHost;
  new HttpErrorFilter().catch(ex, host);
  return out as { status: number; body: Record<string, unknown> };
}

describe("HttpErrorFilter: usedBy and hint (DW-7g-2)", () => {
  it("forwards usedBy and hint next to reason", () => {
    const r = run(new ConflictException({
      message: "5010 is still used", reason: "account_in_use", usedBy: [{ table: "finance_posting_rules", count: 2 }], hint: "Archive it",
    }));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      error: "5010 is still used", reason: "account_in_use", usedBy: [{ table: "finance_posting_rules", count: 2 }], hint: "Archive it",
    });
  });
  it("adds nothing when the thrower set neither (existing callers are unchanged)", () => {
    expect(run(new ConflictException({ message: "m", reason: "r" })).body).toEqual({ error: "m", reason: "r" });
    expect(run(new ConflictException({ message: "m", usedBy: "not an array", hint: 3 })).body).toEqual({ error: "m" });
  });
});
