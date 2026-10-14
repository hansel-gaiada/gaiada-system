// DW-8j (docs/FRONTEND-BFF-CONTRACT.md §48.1) — GMAIL_MODE: `simulated` (the DEFAULT) or `live`.
//
//   * `simulated`  needs no Google client: "connect" links a simulated mailbox at once, threads come from MAIL-16D's fixtures, sends land in
//                  an in-process Sent (memory only) and nothing leaves the box. Every answer carries `mode: "simulated"`.
//   * `live`       is the real Gmail API with the person's own token. It REFUSES TO START unless the Google client env is set
//                  (GOOGLE_GMAIL_CLIENT_ID, GOOGLE_GMAIL_CLIENT_SECRET, GOOGLE_GMAIL_REDIRECT_URI): a boot error, not a request-time 503,
//                  because a request-time failure would surface only after a person had written their message.
//
// A value that is neither word is a boot error too, never a quiet fall-back: a typo'd `GMAIL_MODE=Live ` that silently ran simulated
// would read as "mail is sent" to everyone while nothing left the box. At REQUEST time `gmailMode()` is fail-safe in the other direction:
// anything but the exact word `live` is `simulated` (which can send nothing), so a value that slipped past boot can never send for real.
import { config, gmailLiveConfigured } from "../../config";

export type GmailMode = "simulated" | "live";

export function gmailMode(): GmailMode {
  return config.gmail.mode === "live" ? "live" : "simulated";
}

/** The boot refusals. `override` lets a test drive every cross-product without reloading config.ts. Returns the resolved mode. */
export function assertGmailBootSafe(
  override: { mode?: string; liveConfigured?: boolean } = {},
): GmailMode {
  const raw = (override.mode ?? config.gmail.mode).trim().toLowerCase();
  if (raw !== "simulated" && raw !== "live") {
    throw new Error(`GMAIL_MODE must be "simulated" or "live" (got ${JSON.stringify(raw)}): refusing to start rather than guess what "sent" means`);
  }
  if (raw === "live" && !(override.liveConfigured ?? gmailLiveConfigured())) {
    throw new Error(
      "GMAIL_MODE=live needs the Gmail OAuth client (GOOGLE_GMAIL_CLIENT_ID, GOOGLE_GMAIL_CLIENT_SECRET, GOOGLE_GMAIL_REDIRECT_URI): refusing to start",
    );
  }
  return raw;
}
