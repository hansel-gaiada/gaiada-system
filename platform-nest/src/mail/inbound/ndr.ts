// MAIL-13 — best-effort NDR (bounce) classification (design §7.6 "Bounce synergy" + §7.7).
//
// WHY THIS EXISTS AT ALL: relay sends have no provider event feed. `mail_log.delivered_at` stays
// NULL forever for them and a failed delivery comes back only as an NDR mail to the envelope sender —
// which is our VERP inbound address. Classifying those gives relay sends bounce visibility with no
// provider API, which is the stated inbound bonus.
//
// "BEST-EFFORT" IS LOAD-BEARING, NOT A HEDGE. §15 R4 is the register row that says the dev evidence
// here is a FIXTURE NDR and proves nothing about the real relay's NDR format; the accepted failure
// mode is written down in that row ("bounce shows as `sent`"). So this classifier is built to be
// WRONG IN ONE DIRECTION ONLY:
//
//   * A missed NDR (false negative) leaves the row at `sent` — the already-accepted failure mode.
//   * A FALSE POSITIVE is the harmful direction: it would suppress a real human's address off the
//     back of a crafted reply, i.e. a stranger who guessed a reply token could deny mail to a real
//     recipient. So classification requires TWO independent signals, and a message that merely
//     *mentions* a bounce is never enough.
import type { NormalizedInbound } from "./types";

export type NdrClass = { ndr: false } | { ndr: true; hard: boolean; status: string | null; detail: string };

/** RFC 3463 enhanced status code: 5.x.x is permanent (hard), 4.x.x transient (soft). */
const STATUS_RE = /\b([45])\.(\d{1,3})\.(\d{1,3})\b/;

const DAEMON_LOCALPARTS = ["mailer-daemon", "postmaster", "mail-daemon", "no-reply-bounce"];

const SUBJECT_HINTS = [
  "undeliverable",
  "undelivered mail",
  "delivery status notification",
  "delivery has failed",
  "returned mail",
  "failure notice",
  "mail delivery failed",
  "message not delivered",
  "address not found",
];

function headerText(headers: Record<string, string | string[]>, name: string): string {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v.join(" ").toLowerCase();
  return typeof v === "string" ? v.toLowerCase() : "";
}

/**
 * Two-signal classifier. Signals, any two of which together mean "this is an NDR":
 *   S1  sender local part is a bounce daemon (`MAILER-DAEMON@`, `postmaster@`, ...)
 *   S2  `Content-Type: multipart/report` (optionally `report-type=delivery-status`) — the RFC 3462
 *       machine-readable bounce envelope
 *   S3  `Auto-Submitted:` present and not `no` (RFC 3834 — the header a real human's client never
 *       sets)
 *   S4  subject matches a known NDR phrase
 *   S5  the body carries an RFC 3464 delivery-status report field (`Final-Recipient:` /
 *       `Diagnostic-Code:` / `Action: failed`) — the part a hand-written fake would have to forge
 *       wholesale rather than by accident
 *
 * `hard` requires a 5.x.x enhanced status; anything else (including an NDR with no parseable status)
 * is treated as SOFT, because "we could not classify the severity" must never produce a permanent
 * suppression.
 */
export function classifyNdr(msg: NormalizedInbound): NdrClass {
  const from = msg.fromEmail.toLowerCase();
  const localPart = from.split("@")[0] ?? "";
  const subject = (msg.subject ?? "").toLowerCase();
  const body = `${msg.textBody ?? ""}`;
  const bodyLower = body.toLowerCase();

  const contentType = headerText(msg.headers, "content-type");
  const autoSubmitted = headerText(msg.headers, "auto-submitted");

  const s1 = DAEMON_LOCALPARTS.some((d) => localPart === d || localPart.startsWith(`${d}+`));
  const s2 = contentType.includes("multipart/report");
  const s3 = Boolean(autoSubmitted) && autoSubmitted !== "no";
  const s4 = SUBJECT_HINTS.some((h) => subject.includes(h));
  const s5 =
    /^\s*final-recipient\s*:/im.test(body) ||
    /^\s*diagnostic-code\s*:/im.test(body) ||
    /^\s*action\s*:\s*failed\b/im.test(body);

  const signals = [s1, s2, s3, s4, s5].filter(Boolean).length;
  if (signals < 2) return { ndr: false };

  const statusMatch = STATUS_RE.exec(body) ?? STATUS_RE.exec(bodyLower);
  const status = statusMatch ? statusMatch[0] : null;
  // A 5.x.x code is the ONLY route to a permanent suppression. Note the deliberate asymmetry with
  // §7.7's provider-webhook path, where the provider states `hard_bounce` explicitly: there we trust
  // the provider's own classification, here we insist on the wire-format evidence.
  const hard = Boolean(statusMatch && statusMatch[1] === "5");
  return {
    ndr: true,
    hard,
    status,
    detail: `ndr signals=${[s1 && "daemon-sender", s2 && "multipart/report", s3 && "auto-submitted", s4 && "subject", s5 && "dsn-fields"]
      .filter(Boolean)
      .join("+")}${status ? ` status=${status}` : ""}`,
  };
}
