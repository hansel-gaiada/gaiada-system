// WSK-12 — events (B->A signed webhooks) env config. Same "every field is a live GETTER"
// discipline as ../config.ts / ../forms/forms.config.ts / ../mail/mail.config.ts: process.env
// must be read at call time, never snapshotted at module-import time (ESM import hoisting races a
// test's own `process.env.X = ...` assignment against this module's evaluation otherwise).
//
// `WEBDESK_EVENT_SECRET` ALREADY EXISTS in ../../.env.example (design §11's secrets-custody
// table names it explicitly: "Zone B env: ... WEBDESK_EVENT_SECRET"). This ticket reads it by
// that exact name — no new secret var needed. The bridge URL, timeout, origin-site identity, and
// kill switch below are genuinely new and are NOT yet in .env.example (WSK-01's file, out of this
// ticket's owned scope) — reported as required additions, exactly like WSK-05/07/10/11 each
// reported their own new vars there.
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export const eventsConfig = {
  /** Master kill switch (§03's own fail-soft framing: "a bridge outage must never break a form
   *  submission" — this is the OTHER half of that, "and neither must a bad config"). When false,
   *  the emitter never attempts delivery; it is not an error, just a documented no-op. */
  get enabled(): boolean {
    return bool("WEBDESK_ZONEB_EVENTS_ENABLED", true);
  },

  /** The n8n bridge's `wd-zoneb-intake` trigger URL. Deliberately outside the `/n8n/` basic-auth
   *  gate (§03/§09: "triggers stay outside the basic-auth gate (standing doctrine)"). Empty by
   *  default so a forgotten env var fails an early, loud reachability check rather than silently
   *  aiming at nothing — but a MISSING url still degrades to fail-soft at emit time (§ below),
   *  never a thrown exception a caller has to catch. */
  get bridgeUrl(): string {
    return process.env.WEBDESK_ZONEB_BRIDGE_URL || "";
  },

  /** HMAC signing secret — shared with n8n's verify side (§03/§11: "n8n: WEBDESK_EVENT_SECRET
   *  (verify-side)"). Custody: Zone B env + n8n env, never Zone A. */
  get secret(): string {
    return process.env.WEBDESK_EVENT_SECRET || "";
  },

  /** Zone B's own identity for `origin_site` — a site slug or box name, opaque to Zone A. */
  get originSite(): string {
    return process.env.WEBDESK_ZONEB_ORIGIN_SITE || "webdesk";
  },

  get requestTimeoutMs(): number {
    return Number(process.env.WEBDESK_ZONEB_EVENT_TIMEOUT_MS ?? 5_000);
  },

  /** Replay/staleness tolerance the VERIFY side enforces on the timestamp header — shared here so
   *  webdesk's own tests exercise the exact window the n8n flow is built to. 5 minutes, matching
   *  the estate's existing webhook-signing convention (GitHub/Stripe-style tolerance windows). */
  get toleranceMs(): number {
    return Number(process.env.WEBDESK_ZONEB_EVENT_TOLERANCE_MS ?? 5 * 60_000);
  },
};
