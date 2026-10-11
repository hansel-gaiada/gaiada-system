// M4 telemetry — the on/off decision and the exporter settings parsed from env. Imports NOTHING from
// OpenTelemetry (and nothing from the app), so evaluating the gate costs a few string comparisons and the
// SDK is only ever loaded when this says "on".
//
// STRICT PARSING. The estate has been bitten by an empty env var becoming a value (`${VAR:-}` through `??`
// turned "" into 0 and busy-looped a service). So:
//   - a flag is on ONLY for exactly `true` or `1` (case-insensitive, surrounding whitespace ignored);
//     "", unset, "false", "0", "yes", "on", "TRUE-ish" garbage: all off;
//   - an endpoint is on ONLY when it is a non-empty http(s) URL. A blank or unparseable one is "no endpoint".
// Off is the default and the safe direction for every doubt.

export type Env = Readonly<Record<string, string | undefined>>;

export function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1";
}

export type TelemetryGate =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      /** Full OTLP/HTTP traces URL (the `/v1/traces` path appended unless OTEL_EXPORTER_OTLP_TRACES_ENDPOINT was given whole). */
      tracesUrl: string;
      /** Request headers parsed from OTEL_EXPORTER_OTLP_HEADERS (`k=v,k2=v2`). Holds the bearer: never log it. */
      headers: Record<string, string>;
    };

/** `Authorization=Bearer abc, x-other=1`: split on commas, key/value at the first `=`, both trimmed and percent-decoded. */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || raw.trim() === "") return out;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const dec = (s: string): string => {
      try {
        return decodeURIComponent(s.trim());
      } catch {
        return s.trim();
      }
    };
    const key = dec(pair.slice(0, eq));
    const value = dec(pair.slice(eq + 1));
    // a header name must be a token; anything else would make the exporter's request throw
    if (key !== "" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && !/[\r\n]/.test(value)) out[key] = value;
  }
  return out;
}

function httpUrlOrNull(raw: string | undefined): URL | null {
  if (raw === undefined || raw.trim() === "") return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

export function evaluateTelemetryGate(env: Env = process.env): TelemetryGate {
  if (!isTruthyFlag(env.OTEL_ENABLED)) return { enabled: false, reason: "OTEL_ENABLED is not true" };
  if (!isTruthyFlag(env.WEBDESK_OTEL_ZONEA_PUSH_ENABLED)) return { enabled: false, reason: "WEBDESK_OTEL_ZONEA_PUSH_ENABLED is not true" };

  // This api speaks OTLP over HTTP/protobuf only. An explicit different protocol is a misconfiguration:
  // stay off rather than send something the receiver (or the SDK) does not understand.
  const protocol = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "").trim().toLowerCase();
  if (protocol !== "" && protocol !== "http/protobuf") return { enabled: false, reason: `unsupported OTLP protocol (only http/protobuf)` };

  const whole = httpUrlOrNull(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const base = httpUrlOrNull(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  let tracesUrl: string;
  if (whole) {
    tracesUrl = whole.toString();
  } else if (base) {
    // Per the OTLP spec a generic endpoint gets the signal path appended.
    tracesUrl = `${base.toString().replace(/\/+$/, "")}/v1/traces`;
  } else {
    return { enabled: false, reason: "no valid OTLP endpoint" };
  }
  return { enabled: true, tracesUrl, headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS) };
}
