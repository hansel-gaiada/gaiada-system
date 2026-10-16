// DW-10b (BFF §58.3): HttpErrorFilter forwards `failedId`, the row that stopped a batch decision, the way it forwards `reason`
// and `usedBy`. Without the forward the `{error}` reshape drops it silently and the screen cannot point at the proposal.
import { describe, it, expect } from "vitest";
import { ConflictException, ForbiddenException, NotFoundException, type ArgumentsHost, type HttpException } from "@nestjs/common";
import { HttpErrorFilter } from "./http-error.filter";

function run(ex: HttpException): { status: number; body: Record<string, unknown> } {
  let out: { status: number; body: Record<string, unknown> } | undefined;
  const reply = { header: () => undefined, status: (s: number) => ({ send: (b: Record<string, unknown>) => { out = { status: s, body: b }; } }) };
  const host = { switchToHttp: () => ({ getResponse: () => reply }) } as unknown as ArgumentsHost;
  new HttpErrorFilter().catch(ex, host);
  return out as { status: number; body: Record<string, unknown> };
}

describe("HttpErrorFilter: failedId (DW-10b)", () => {
  it("forwards failedId on a 404, a 409 and a 403", () => {
    expect(run(new NotFoundException({ message: "target not found", failedId: "t1" }))).toEqual({ status: 404, body: { error: "target not found", failedId: "t1" } });
    expect(run(new ConflictException({ message: "not_proposed", failedId: "t2" })).body).toEqual({ error: "not_proposed", failedId: "t2" });
    expect(run(new ForbiddenException({ message: "not authorized: x", reason: "assurance_required", failedId: "t3" })).body).toEqual({
      error: "not authorized: x", reason: "assurance_required", failedId: "t3",
    });
  });
  it("adds nothing when the thrower set none, or set a non-string (existing callers are unchanged)", () => {
    expect(run(new ConflictException({ message: "m" })).body).toEqual({ error: "m" });
    expect(run(new ConflictException({ message: "m", failedId: 7 })).body).toEqual({ error: "m" });
    expect(run(new ConflictException({ message: "m", failedId: "" })).body).toEqual({ error: "m" });
  });
});
