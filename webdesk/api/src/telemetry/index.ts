// M4 telemetry — the entry point main.ts calls FIRST, before anything it instruments is loaded.
//
// Off (the default): evaluateTelemetryGate() is a handful of string comparisons; the SDK module is never
// imported, so no @opentelemetry package is required and nothing is patched. On: the SDK is imported
// lazily here. Either way this function NEVER throws and never rejects: a telemetry fault is a warning
// and the api boots exactly as it would without telemetry.
import { evaluateTelemetryGate, type Env } from "./gate";
import type { TelemetryHandle } from "./sdk";

let handle: TelemetryHandle | undefined;

export interface InitDeps {
  /** The lazy loader. Replaced in tests to prove it is not called while the gate is off. */
  load?: () => Promise<typeof import("./sdk")>;
  warn?: (message: string) => void;
}

export async function initTelemetry(env: Env = process.env, deps: InitDeps = {}): Promise<boolean> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  try {
    const gate = evaluateTelemetryGate(env);
    if (!gate.enabled) return false; // silent: off is the normal state
    if (handle) return true;
    const sdk = await (deps.load ?? (() => import("./sdk")))();
    handle = sdk.startTelemetry({ gate, warn });
    console.log("[webdesk:otel] tracing on (OTLP/HTTP protobuf, traces only)");
    return true;
  } catch (err) {
    // Say what failed, never the endpoint or the headers (the bearer lives there).
    warn(`[webdesk:otel] tracing disabled, SDK failed to start: ${err instanceof Error ? err.name : "unknown error"}`);
    handle = undefined;
    return false;
  }
}

/** Flush and stop. A no-op when telemetry never started. Bounded; never throws. */
export async function shutdownTelemetry(timeoutMs?: number): Promise<void> {
  const h = handle;
  handle = undefined;
  if (!h) return;
  try {
    await h.shutdown(timeoutMs);
  } catch {
    // nothing a shutdown can do about it
  }
}
