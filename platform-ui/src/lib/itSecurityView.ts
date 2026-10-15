// DW-7h: the plain words and small rules behind IT > Network (BFF §52). Pure and client-safe: the pages and the client forms
// share it, and it imports only TYPES from the server-only reader (erased at build time).
import type { Alert, AlertKind, Connection, IpBlock, Revocation, SecurityWindow, SignInWindow } from "./itSecurity";

export const WINDOW_LABEL: Record<SecurityWindow, string> = { "15m": "Last 15 minutes", "24h": "Last 24 hours", "7d": "Last 7 days" };

/** A `?window=` value, or the fallback. The server answers 400 for anything else, so an odd value in the URL is never forwarded. */
export function parseWindow<W extends SecurityWindow>(value: string | string[] | undefined, allowed: readonly W[], fallback: W): W {
  const v = Array.isArray(value) ? value[0] : value;
  return allowed.find((w) => w === v) ?? fallback;
}

export const CONNECTION_WINDOWS: readonly SecurityWindow[] = ["15m", "24h", "7d"];
export const SIGN_IN_WINDOWS: readonly SignInWindow[] = ["24h", "7d"];

/** What each alert rule means, in the words IT would use to explain it to a colleague (BFF §52.6). */
export const ALERT_RULES: Record<AlertKind, { label: string; meaning: string }> = {
  failed_signins_account: {
    label: "Repeated failed sign-ins on one account",
    meaning: "5 or more failed sign-ins for one person's account within 15 minutes. Someone may be guessing the password.",
  },
  failed_signins_ip: {
    label: "Repeated failed sign-ins from one address",
    meaning: "10 or more failed sign-ins from one network address within 15 minutes, counting this company's people and accounts we do not know. One address is trying many logins.",
  },
  new_device: {
    label: "First sign-in from a new device or address",
    meaning: "A person who has connected before is now connecting from an address and device we have not seen them use. Often a new phone or a trip; worth a question if it is unexpected.",
  },
  blocked_ip_hits: {
    label: "A blocked address kept trying",
    meaning: "An address you blocked for this company was turned away in this window.",
  },
};

export function alertLabel(kind: string): string {
  return (ALERT_RULES as Record<string, { label: string }>)[kind]?.label ?? kind.replaceAll("_", " ");
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;
export const SEVERITY_LABEL = { high: "High", medium: "Medium", low: "Low" } as const;

/** Newest first, as the server sends them. Severity is a chip, never the sort: a fresh medium should not sit below an old high. */
export function countBySeverity(alerts: readonly Pick<Alert, "severity">[]): Record<"high" | "medium" | "low", number> {
  const out = { high: 0, medium: 0, low: 0 };
  for (const a of alerts) out[a.severity] += 1;
  return out;
}
export const bySeverityThenNewest = (a: Alert, b: Alert) =>
  SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.at.localeCompare(a.at);

export const DEVICE_KIND_LABEL = { desktop: "Computer", mobile: "Phone", tablet: "Tablet", unknown: "Device" } as const;

/** "Chrome on macOS" — the parts the server could tell. */
export function describeDevice(d: Connection["device"]): string {
  const known = (s: string) => (s && s.toLowerCase() !== "unknown" ? s : "");
  const browser = known(d.browser);
  const os = known(d.os);
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || "Unknown browser";
}

/** The person for a row: the name when the server gave one, else the address, else the id (never blank). */
export function personOf(p: { displayName?: string | null; email?: string | null; userId: string }): string {
  return p.displayName || p.email || p.userId;
}

/** "3 minutes ago", measured from the server's own `asOf`, so the same answer reads the same on every render. */
export function agoFrom(asOf: string, iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.parse(asOf) - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

/** Why a past block is past, in a word. */
export function blockEndedAs(b: Pick<IpBlock, "liftedAt" | "expiresAt">): "lifted" | "expired" {
  // The create route marks an expired block lifted at its own expiry, so a `liftedAt` equal to `expiresAt` is an expiry.
  return b.liftedAt !== null && b.liftedAt !== b.expiresAt ? "lifted" : "expired";
}

/** Hours to a short phrase: 1 hour, 24 hours, 7 days. */
export function hoursPhrase(hours: number): string {
  if (hours % 24 === 0 && hours >= 48) return `${hours / 24} days`;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export const BLOCK_DURATIONS: readonly { hours: number; label: string }[] = [
  { hours: 1, label: "1 hour" }, { hours: 24, label: "24 hours" }, { hours: 168, label: "7 days" }, { hours: 720, label: "30 days" },
];

export function revocationOf(r: Revocation): string {
  return r.sessionId === null ? "Login blocked: every session before this was ended" : "Signed out";
}

/** The sentence for a sign-ins state that has no events. `off` and `unavailable` are different statements and are never worded alike. */
export function signInsStateWords(state: "off" | "unavailable", reason?: string): { title: string; body: string } {
  if (state === "off") {
    return {
      title: "Sign-in events are not being recorded",
      body: "The sign-in service is not keeping a record of who signs in, so there is nothing to show. This is not a statement that nobody signed in, or that nobody failed. Ask whoever looks after the sign-in service to turn event recording on.",
    };
  }
  return {
    title: "Sign-ins cannot be read right now",
    body: `The sign-in record could not be read${reason ? `: ${reason}` : "."} This is not a statement that nobody signed in, or that nobody failed. The role that reads events may be missing. Everything else keeps working.`,
  };
}
