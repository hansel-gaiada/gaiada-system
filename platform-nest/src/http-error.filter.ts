// Contract-parity error shape. The Fastify server sent every error as { error: "<message>" }.
// Nest's default HttpException body is { statusCode, message, error }, which would break the UI
// and bot that read `.error`. This filter reshapes all HttpExceptions back to { error: msg }
// with the same status code. A4: also forwards an optional `field` (validation errors that
// name which input was bad, e.g. the bot's own group/config field checks) when the thrown
// exception's response object carries one — purely additive, existing callers never set it.
//
// MI-03: also forwards an optional `existing` OBJECT, for the one error class where the error itself
// has to carry a usable result. The webdev triage endpoint's 409 ("this change request was already
// triaged") must hand the loser of a race the artifact that already exists, so a double-click / retry
// / concurrent decider can navigate to the run or task instead of being told only that it failed. The
// `{error}` reshape above would otherwise DROP that field silently — an error shape quietly eating a
// contract field is exactly the kind of thing a 409's status code alone makes look fine. Same additive
// rule as `field`: only present when the thrown exception set it, so no existing caller changes.
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { FastifyReply } from "fastify";

@Catch(HttpException)
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const status = exception.getStatus();
    const res = exception.getResponse();
    let error: string;
    let field: string | undefined;
    let existing: Record<string, unknown> | undefined;
    let site: Record<string, unknown> | undefined;
    let reason: string | undefined;
    let blockers: unknown[] | undefined;
    let detail: Record<string, unknown> | undefined;
    let retryAfterSeconds: number | undefined;
    let usedBy: unknown[] | undefined;
    let hint: string | undefined;
    let failedId: string | undefined;
    if (typeof res === "string") {
      error = res;
    } else {
      const r = res as {
        message?: string | string[]; field?: string; existing?: unknown; site?: unknown;
        reason?: string; blockers?: unknown; detail?: unknown; retryAfterSeconds?: unknown;
        usedBy?: unknown; hint?: unknown; failedId?: unknown;
      };
      const m = r.message;
      error = Array.isArray(m) ? m.join(", ") : m ?? exception.message;
      if (typeof r.field === "string") field = r.field;
      // AD-2: `reason`, same additive rule as `field`/`existing`/`site`. The agency intake guard
      // refuses an anonymous prospect with a MACHINE code (`token_expired`, `token_used`, …) and
      // the documented contract says a caller branches on it. Without this line the field was
      // silently dropped by the reshape below and only survived because the guard also copies it
      // into `message` — so the documented field name was one nobody could actually read. QA caught
      // that; forwarding it is the honest fix, and it is what agentic-native criterion 2 (typed
      // refusals, not prose) actually requires.
      if (typeof r.reason === "string") reason = r.reason;
      // PV5-04: `blockers`, same additive rule. Issuing an invoice refuses with EVERY missing prerequisite at once
      // (`[{ code, message }]`), so the UI can list them instead of showing the first one and failing again.
      if (Array.isArray(r.blockers)) blockers = r.blockers;
      // DW-5a: `detail`, same additive rule. A typed money refusal carries the figures that explain it
      // (`allocation_exceeds_budget` -> `{budgetMinor, allocatedMinor, requestedMinor}`, FRONTEND-BFF-CONTRACT §31.3),
      // so the UI shows them without a second read. Only present when the thrower set it.
      if (r.detail && typeof r.detail === "object" && !Array.isArray(r.detail)) {
        detail = r.detail as Record<string, unknown>;
      }
      // DW-8j: `retryAfterSeconds`, same additive rule. A 429 says how long to wait (`gmail_send_rate_limited`, FRONTEND-BFF-CONTRACT
      // §48.4), so the UI shows the wait without guessing; the standard `Retry-After` header carries the same whole number.
      if (typeof r.retryAfterSeconds === "number" && Number.isFinite(r.retryAfterSeconds) && r.retryAfterSeconds > 0) {
        retryAfterSeconds = Math.ceil(r.retryAfterSeconds);
      }
      // DW-7g-2 (BFF §49.4): `usedBy` and `hint`, same additive rule. Archiving a chart account that something still posts
      // to is 409 `account_in_use` and lists WHICH tables (`[{table, count}]`), so the screen can say what to repoint; a
      // frozen account (`account_frozen`) carries the database's own hint ("archive it and create a new one").
      if (Array.isArray(r.usedBy)) usedBy = r.usedBy;
      if (typeof r.hint === "string" && r.hint) hint = r.hint;
      // DW-10b (BFF §58.3): `failedId`, same additive rule. A batch that decides several rows at once refuses as a whole and
      // names the row that stopped it (404, 409 or 403), so the screen can point at that proposal.
      if (typeof r.failedId === "string" && r.failedId) failedId = r.failedId;
      if (r.existing && typeof r.existing === "object" && !Array.isArray(r.existing)) {
        existing = r.existing as Record<string, unknown>;
      }
      // PRV-04: `site`, same additive rule as `field`/`existing`. The provisioning surface refuses
      // with a typed token AND the mirror row it just committed, so a client can show what actually
      // happened without a second round trip.
      //
      // ⚠️ THE BUG THIS CLOSES, because it is the trap of this whole file: the controller originally
      // threw `{ error: "<token>", site }`, and NOTHING here reads `error` — the reshape below RENAMES
      // `message` to `error` on the way out. So every typed token (`slug_conflict_foreign`,
      // `egress_error`, …) was replaced by Nest's constructor-derived string ("Conflict Exception")
      // and `site` was dropped entirely. It looked fine: the status codes were right and the shape
      // was right, only the meaning was missing. A thrower here must set `message`, not `error`.
      if (r.site && typeof r.site === "object" && !Array.isArray(r.site)) {
        site = r.site as Record<string, unknown>;
      }
    }
    if (retryAfterSeconds !== undefined) void reply.header("retry-after", String(retryAfterSeconds));
    void reply.status(status).send({
      error,
      ...(field ? { field } : {}),
      ...(reason ? { reason } : {}),
      ...(existing ? { existing } : {}),
      ...(site ? { site } : {}),
      ...(blockers ? { blockers } : {}),
      ...(detail ? { detail } : {}),
      ...(usedBy ? { usedBy } : {}),
      ...(hint ? { hint } : {}),
      ...(failedId ? { failedId } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
  }
}
