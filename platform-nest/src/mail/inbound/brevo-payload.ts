// MAIL-13 — Brevo inbound-parse payload → `NormalizedInbound` (design §7.6).
//
// SHAPE PROVENANCE (verified against Brevo's published inbound-parse documentation at build time,
// 2026-08-04): the POST body is `{ "items": [ ... ] }` and each item carries `Uuid` (array),
// `MessageId`, `InReplyTo`, `From`/`To`/`Cc`/`ReplyTo` as `{Name, Address}` mailboxes, `Recipients`
// (the RCPT TO list), `SentAtDate`, `Subject`, `RawHtmlBody`, `RawTextBody`,
// `ExtractedMarkdownMessage`, `ExtractedMarkdownSignature`, `Attachments`
// (`{Name, ContentType, ContentLength, ContentID, DownloadToken}`), `Headers`, and `SpamScore`.
// It is still a RECORDED SHAPE, not a contract with a live provider — §15 R3 ("real payload shapes
// match the recorded-shape corpus") is the row that closes that gap, and this parser is written
// tolerantly (every field optional, every type coerced) so a drifted real payload degrades to a
// partially-populated row rather than a 500.
//
// ⚠ HONEST GAP, ARCHITECT-VISIBLE: Brevo's inbound payload does NOT inline attachment bytes — it
// hands out a `DownloadToken` to be exchanged at Brevo's API with an account key. Dev has no Brevo
// account (M15), so the committed corpus inlines bytes via a `Content` field (base64) and the
// quarantine/scan path is exercised end to end against those. The staging leg must add the
// token→bytes fetch behind the same `NormalizedAttachment` shape; nothing downstream of this file
// changes. Tracked as a §15 R3 addition in the ticket report.
import type { NormalizedAttachment, NormalizedInbound } from "./types";

interface BrevoMailbox {
  Name?: unknown;
  Address?: unknown;
}

interface BrevoAttachment {
  Name?: unknown;
  ContentType?: unknown;
  ContentLength?: unknown;
  ContentID?: unknown;
  DownloadToken?: unknown;
  /** NOT a Brevo field — the fixture-corpus extension that inlines bytes (see the header note). */
  Content?: unknown;
}

interface BrevoItem {
  MessageId?: unknown;
  Uuid?: unknown;
  From?: BrevoMailbox;
  To?: unknown;
  Cc?: unknown;
  Recipients?: unknown;
  Subject?: unknown;
  RawTextBody?: unknown;
  RawHtmlBody?: unknown;
  ExtractedMarkdownMessage?: unknown;
  Attachments?: unknown;
  Headers?: unknown;
}

export class MalformedInboundPayloadError extends Error {}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function mailboxAddress(value: unknown): string | null {
  if (typeof value === "string") return extractAngleAddress(value);
  if (value && typeof value === "object") return extractAngleAddress(str((value as BrevoMailbox).Address) ?? "");
  return null;
}

/** Accepts both `a@b.test` and `Display Name <a@b.test>`; returns the bare address with the DOMAIN
 *  lowercased and the LOCAL PART case preserved.
 *
 *  MAIL-29: this used to blanket-lowercase the whole address, which was wrong on both halves of email
 *  address semantics — the domain is case-insensitive (correct to normalize) but the local part is
 *  technically case-sensitive (RFC 5321 §2.4) and, concretely here, IS the VERP reply token
 *  (`reply+<token>@…`, see `../intake.ts`). Tokens are minted as mixed-case base64url
 *  (`randomBytes(16).toString("base64url")`, `queue.ts`'s `newReplyToken`) and matched against
 *  `mail_log.reply_token` with case-sensitive `=`. Folding the local part to lowercase before
 *  extraction meant any token containing an uppercase character — the large majority of them — could
 *  never match, so inbound threading (MAIL-13) silently never worked outside a test corpus whose own
 *  tokens happened to be all-lowercase (see `corpus.test.ts`'s header note on `seedMail`). Recipient
 *  addresses feed `extractReplyToken` in `../intake.ts`, so preserving local-part case here is what
 *  makes the match key match. `From:` case is display metadata (§7.6) either way — a sender address
 *  never influences routing or authorization — so preserving its case too is harmless and simply
 *  correct, not a behavior this file has any reason to special-case away from recipients. */
function extractAngleAddress(raw: string): string | null {
  const angle = /<([^<>]+)>/.exec(raw);
  const candidate = (angle ? angle[1] : raw).trim();
  const at = candidate.lastIndexOf("@");
  if (at <= 0) return null;
  const local = candidate.slice(0, at);
  const domain = candidate.slice(at + 1);
  if (!local.length || !domain.length) return null;
  return `${local}@${domain.toLowerCase()}`;
}

function mailboxList(value: unknown): string[] {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map(mailboxAddress).filter((a): a is string => Boolean(a));
}

function headers(value: unknown): Record<string, string | string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.filter((x): x is string => typeof x === "string");
  }
  return out;
}

function attachments(value: unknown): NormalizedAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const a = (raw ?? {}) as BrevoAttachment;
    const inline = str(a.Content);
    // Base64 decoding is intentionally lenient: Node ignores non-base64 characters rather than
    // throwing, so a corrupt fixture yields fewer bytes instead of a 500. The size caps downstream
    // key off the DECODED length, never the declared one.
    const content = inline ? Buffer.from(inline, "base64") : null;
    return {
      name: str(a.Name) ?? "attachment",
      contentType: str(a.ContentType) ?? "application/octet-stream",
      content,
      declaredBytes: content ? content.byteLength : num(a.ContentLength),
      downloadToken: str(a.DownloadToken),
    };
  });
}

/** Parses one Brevo inbound POST body into the normalized items it contains.
 *
 *  Throws `MalformedInboundPayloadError` only for a body that is not an object with an `items`
 *  array — the caller turns that into a 400 + `mail_inbound_rejected_total{reason="malformed"}`. A
 *  well-formed envelope containing a nonsense item does NOT throw: the item normalizes to a row with
 *  empty fields and then fails the token match, which is the A9 drop path (204), not an error. */
export function parseBrevoInbound(body: unknown, rawByteLength: number): NormalizedInbound[] {
  if (!body || typeof body !== "object") throw new MalformedInboundPayloadError("body is not an object");
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new MalformedInboundPayloadError("body.items is not an array");

  // Total delivery size is attributed evenly across items for cap accounting; in practice Brevo
  // posts one item per delivery. Using the RAW byte length (not a re-serialization) means the cap is
  // measured on what actually crossed the wire.
  const perItem = items.length ? Math.ceil(rawByteLength / items.length) : rawByteLength;

  return items.map((raw) => {
    const item = (raw ?? {}) as BrevoItem;
    const atts = attachments(item.Attachments);
    return {
      provider: "brevo-inbound",
      // `MessageId` is the RFC 5322 Message-ID; `Uuid[0]` is Brevo's own id. Preferring MessageId
      // and falling back to the Uuid means idempotency still holds for a message with no
      // Message-ID header (spam often omits it). An item with NEITHER gets "" and is rejected by the
      // caller — an un-keyable delivery cannot be made idempotent and must not be stored.
      providerMessageId:
        str(item.MessageId) ?? (Array.isArray(item.Uuid) ? str(item.Uuid[0]) : null) ?? "",
      fromEmail: mailboxAddress(item.From) ?? "unknown@invalid",
      // RCPT TO first: it is the envelope recipient the MTA actually delivered to, which is where the
      // VERP token lives even when the visible To: header was rewritten by a forwarder.
      recipientAddresses: [
        ...mailboxList(item.Recipients),
        ...mailboxList(item.To),
        ...mailboxList(item.Cc),
      ],
      subject: str(item.Subject),
      textBody: str(item.RawTextBody) ?? str(item.ExtractedMarkdownMessage),
      htmlBody: str(item.RawHtmlBody),
      attachments: atts,
      headers: headers(item.Headers),
      sizeBytes: perItem,
    };
  });
}
