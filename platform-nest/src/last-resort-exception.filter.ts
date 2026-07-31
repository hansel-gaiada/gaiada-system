// SM-58 — app-wide last-resort exception filter (tracker §6ad Ruling 2, off the back of SM-53/§6aa
// and SM-57/§6ae).
//
// The structural floor under both prior bugs: `HttpErrorFilter` is `@Catch(HttpException)`, so ANY
// uncaught plain `Error` ANYWHERE in the app — not just the two search-module instances already
// fixed one at a time (SM-53's `ProviderDispatchError` family, SM-57's `GatewayNotConfiguredError`)
// — falls through to Nest's default exception handler, which returns a 500 whose body does NOT
// match the app-wide `{ error }` contract the UI and the WhatsApp bot both read via `.error`. An
// unexpected fault doesn't merely fail, it fails in a shape callers cannot parse — which is why both
// prior instances presented as "the platform broke" rather than as anything diagnosable. This filter
// is the backstop for every future instance of that same class, not a third instance of the fix.
//
// `@Catch()` — no argument — matches EVERY thrown value, by design: this is the "nothing more
// specific matched" case, and it must never be narrowed to a type list, or the next unclassified
// fault falls back through it exactly like the two it was built to stop.
//
// PRECEDENCE — the part that is easy to get backwards (see the filter's own test file for the
// empirical proof, not just this comment): Nest's `ExceptionsHandler` picks the FIRST filter in its
// internal list whose `@Catch` type matches (`Array.prototype.find`), and `RouterExceptionFilters`
// REVERSES the array passed to `useGlobalFilters(...)` before storing it
// (`node_modules/@nestjs/core/router/router-exception-filters.js`). That means the LAST argument
// passed to `useGlobalFilters(...)` is checked FIRST, not last. A type-scoped `@Catch(X)` filter only
// ever matches its own type regardless of position, so their relative order never matters — but this
// filter's `@Catch()` matches UNCONDITIONALLY, so if it were the last argument it would be checked
// first and would shadow `HttpErrorFilter`/`ProviderDispatchErrorFilter`/
// `GatewayNotConfiguredErrorFilter` for every single request. It must be registered as the FIRST
// argument to `useGlobalFilters(...)` so the reversal puts it LAST in the checked order — genuinely
// last-resort, not merely last-declared.
//
// CLIENT vs. LOG — deliberately asymmetric, and that asymmetry is the point of the ticket:
// A raw `Error.message` from an unmapped fault could be ANYTHING, because this filter exists
// precisely for faults nobody has classified yet — a Postgres error naming a column or constraint, a
// connection string, a stack frame carrying a filesystem path, a third-party SDK error echoing back
// a token or header. Unlike SM-53/57's typed refusals (authored by us, message contents are known
// and deliberately human-actionable), there is no way to allowlist what is safe to forward here. So
// the client ALWAYS gets a fixed, context-free string — never `exception.message`, never the stack
// — while the real fault (name, message, stack) and the failing route go server-side only:
//   - recorded on the active OTel span, if one exists (WS9's HTTP auto-instrumentation starts one per
//     request; `providers/dispatch.ts` already does the identical `recordException`/`setStatus`
//     dance on its own internal span, so this mirrors an established in-repo pattern rather than
//     inventing a new one), so the fault joins the trace in Tempo/Grafana; and
//   - always to stderr via `console.error`, unconditionally — a fault that only reached a span would
//     vanish entirely when `OTEL_ENABLED` is unset (dev, most test runs), which is worse than a bad
//     status code because then NOTHING diagnosable survives the request at all.
//
// Body carries `code: "internal_error"` alongside `error`, matching the FRONTEND-BFF-CONTRACT
// Conventions entry SM-57 added (`{ error, field?, code? }`, additive/optional) — a fixed, generic
// discriminator costs nothing to add and lets a caller distinguish "an unclassified server fault"
// from any other error shape without string-matching the (also fixed) `error` text.
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";

// QA-adversarial finding (second pass, off the back of the 26-test DEV-VERIFIED gate): `exception
// instanceof Error` is true for ANY object on the Error prototype chain, including a hand-crafted
// subclass/instance whose `.message` or `.name` is a GETTER that throws or returns attacker
// content on access (e.g. `Object.defineProperty(err, "message", { get() { throw ...; } })`). The
// original code dereferenced `err.name`/`err.message` directly in the console.error template
// literal and again via `span.setStatus({ message: err.message })` — a throwing getter there
// crashes THIS filter's own `catch()`, which is strictly worse than a leaky response: this is the
// last filter in the chain, so nothing downstream can recover and Fastify never sends a response
// at all. `readSafely` isolates every dereference of untrusted exception state behind its own
// try/catch so a hostile getter can degrade the LOGGED fault but can never crash the handler.
function readSafely(fn: () => unknown, fallback: string): string {
  try {
    const v = fn();
    return typeof v === "string" ? v : String(v);
  } catch {
    return fallback;
  }
}

/** Normalizes ANY thrown value (Error, Error subclass with hostile getters, plain string, null,
 *  undefined, a circular-reference object, an object with a hostile toString) into a fresh, inert
 *  Error whose name/message/stack were each read defensively — so nothing downstream (console.error,
 *  the OTel span) ever touches the original exception's accessors more than once. */
function toSafeFault(exception: unknown): Error {
  if (exception instanceof Error) {
    const name = readSafely(() => exception.name, "Error");
    const message = readSafely(() => exception.message, "<unreadable exception.message>");
    const stack = readSafely(() => exception.stack, "");
    const safe = new Error(message);
    safe.name = name;
    if (stack) safe.stack = stack;
    return safe;
  }
  const message = readSafely(() => String(exception), "<unstringifiable thrown value>");
  return new Error(message);
}

@Catch()
export class LastResortExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const httpCtx = host.switchToHttp();
    const reply = httpCtx.getResponse<FastifyReply>();
    const request = httpCtx.getRequest<FastifyRequest | undefined>();
    const err = toSafeFault(exception);
    const method = request?.method ?? "?";
    const url = request?.url ?? "?";

    // Server-side only, unconditionally — must survive even when OTEL_ENABLED is unset, which is
    // most dev/test runs, so this cannot be the only place the fault is recorded.
    // eslint-disable-next-line no-console
    console.error(`[unhandled-exception] ${method} ${url} -> ${err.name}: ${err.message}`, err.stack);

    // Additionally join the active OTel span (if WS9 telemetry started one for this request), so the
    // fault is visible in Tempo/Grafana alongside every other traced call — mirrors
    // providers/dispatch.ts's own recordException/setStatus use on its internal span. `err` is
    // ALREADY the normalized, inert copy from toSafeFault(), so this never re-dereferences the
    // original (possibly hostile) exception's accessors.
    const span = trace.getSpan(context.active());
    if (span) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    }

    // Client-side: fixed and context-free, on purpose — see the file header. Never exception.message,
    // never exception.stack, never the raw `exception` value.
    void reply.status(500).send({ error: "internal error", code: "internal_error" });
  }
}
