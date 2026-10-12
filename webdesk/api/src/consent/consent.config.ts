// M5-G6 — consent-log env config. Same discipline as ../scheduler/scheduler.config.ts and ../forms/forms.config.ts:
// every value is read from process.env when asked for (never snapshotted at import), and an EMPTY variable
// means "the default", never 0 (compose passes `${VAR:-}` through as an empty string when nothing is set, and
// `Number("")` is 0: a 0-month retention would purge every consent record on the next hourly run).
//
//   WEBDESK_CONSENT_RETENTION_MONTHS         how long a consent id's history is kept after its LATEST record.
//                                            Default 26 = data lifetime 14 + 1 year (addendum section 5). Allowed 1-120.
//   WEBDESK_CONSENT_RATE_LIMIT_IP_PER_WINDOW / _IP_WINDOW_MS         per client IP. Default 60 per 10 minutes.
//   WEBDESK_CONSENT_RATE_LIMIT_TENANT_PER_WINDOW / _TENANT_WINDOW_MS per tenant. Default 3000 per 10 minutes.
//
// A malformed or out-of-range value is a loud refusal naming the variable (a purge that silently ran with a
// wrong horizon is worse than a job that fails and is seen).
export const RETENTION_MONTHS = { default: 26, min: 1, max: 120 } as const;

export class ConsentConfigError extends Error {
  constructor(message: string) {
    super(`[webdesk:consent] ${message}`);
    this.name = "ConsentConfigError";
  }
}

function present(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name];
  if (v === undefined) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function whole(env: NodeJS.ProcessEnv, name: string, range: { default: number; min: number; max: number }): number {
  const v = present(env, name);
  if (v === null) return range.default;
  const n = /^\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < range.min || n > range.max) {
    throw new ConsentConfigError(
      `${name}=${JSON.stringify(v)} is not allowed: it must be a whole number from ${range.min} to ${range.max}. ` +
        `Unset it (or leave it empty) for the default of ${range.default}.`,
    );
  }
  return n;
}

/** Months of retention after a consent id's latest record. Empty or unset is the default (26), never 0. */
export function resolveConsentRetentionMonths(env: NodeJS.ProcessEnv = process.env): number {
  return whole(env, "WEBDESK_CONSENT_RETENTION_MONTHS", RETENTION_MONTHS);
}

export const consentConfig = {
  /** Hard cap on the request body's serialized size. The honest body is ~150 bytes. */
  maxBodyBytes: 2048,
  get retentionMonths(): number {
    return resolveConsentRetentionMonths();
  },
  get ipLimitPerWindow(): number {
    return whole(process.env, "WEBDESK_CONSENT_RATE_LIMIT_IP_PER_WINDOW", { default: 60, min: 1, max: 1_000_000 });
  },
  get ipWindowMs(): number {
    return whole(process.env, "WEBDESK_CONSENT_RATE_LIMIT_IP_WINDOW_MS", { default: 600_000, min: 1000, max: 86_400_000 });
  },
  get tenantLimitPerWindow(): number {
    return whole(process.env, "WEBDESK_CONSENT_RATE_LIMIT_TENANT_PER_WINDOW", { default: 3000, min: 1, max: 10_000_000 });
  },
  get tenantWindowMs(): number {
    return whole(process.env, "WEBDESK_CONSENT_RATE_LIMIT_TENANT_WINDOW_MS", { default: 600_000, min: 1000, max: 86_400_000 });
  },
};
