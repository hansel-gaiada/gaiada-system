// DW-8j (docs/FRONTEND-BFF-CONTRACT.md §48.4) — the ONE definition of a valid outgoing message, shared by the HTTP service (which turns a
// body into a typed request) and every GmailClient implementation (which re-validates, so a client can never be handed a header-injection
// string by a caller that skipped the service). Pure: no I/O.
//
// THE RULES (§48.4):
//   * `to`: at least one address; `cc` optional; at most 20 addresses in all, each a valid bare address;
//   * `subject`: 1 to 300 characters, one line;
//   * `body`: plain text, 1 to 50,000 characters;
//   * `inReplyTo`: a thread id and a message id, both shaped like an id.
//
// An address is validated as a bare addr-spec on purpose: a display name (`"A" <a@b.c>`), a comma-separated list or an angle bracket is
// refused, because every one of them is a way to smuggle a second recipient or a header into the message. A line break, a NUL or any other
// control character anywhere in an address or the subject is refused for the same reason (header injection).
import { GmailInvalidMessageError } from "./errors";
import type { GmailSendRequest } from "./types";

export const MAX_RECIPIENTS = 20;
export const SUBJECT_MAX = 300;
export const BODY_MAX = 50_000;
const ADDRESS_MAX = 254;
const ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;
// addr-spec, deliberately conservative: dot-atom local part (RFC 5322 atext) and a dotted hostname. Not an RFC validator; a typo that
// passes simply bounces, while a pattern rejecting a real address would be worse.
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function isValidEmailAddress(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > ADDRESS_MAX) return false;
  if (CONTROL.test(v)) return false;
  const at = v.lastIndexOf("@");
  if (at < 1 || at > 64) return false; // the local part is at most 64 characters
  return ADDRESS.test(v);
}

function addressList(field: "to" | "cc", v: unknown, required: boolean): string[] {
  if (v === undefined || v === null) {
    if (required) throw new GmailInvalidMessageError(field, "at least one recipient is required");
    return [];
  }
  if (!Array.isArray(v)) throw new GmailInvalidMessageError(field, "must be a list of email addresses");
  if (required && v.length === 0) throw new GmailInvalidMessageError(field, "at least one recipient is required");
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") throw new GmailInvalidMessageError(field, "every recipient must be an email address");
    const a = raw.trim();
    if (!isValidEmailAddress(a)) throw new GmailInvalidMessageError(field, "one of the recipients is not a valid email address");
    out.push(a);
  }
  return out;
}

/** Validates and normalises a send request (trims addresses, drops a duplicate address, an address already in `to` is dropped from
 *  `cc`). Throws `GmailInvalidMessageError` naming the first field that fails. The count rule applies to what the caller SENT, before
 *  de-duplication, so a list that is too long is refused as it was written. */
export function validateSendRequest(input: unknown): GmailSendRequest {
  const r = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const to = addressList("to", r.to, true);
  const cc = addressList("cc", r.cc, false);
  if (to.length + cc.length > MAX_RECIPIENTS) {
    throw new GmailInvalidMessageError(to.length > MAX_RECIPIENTS ? "to" : "cc", `at most ${MAX_RECIPIENTS} recipients in all`);
  }
  const seen = new Set<string>();
  const dedupe = (list: string[]) =>
    list.filter((a) => {
      const k = a.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const toOut = dedupe(to);
  const ccOut = dedupe(cc);

  const subject = r.subject;
  if (typeof subject !== "string" || subject.trim().length === 0) throw new GmailInvalidMessageError("subject", "a subject is required");
  if (subject.length > SUBJECT_MAX) throw new GmailInvalidMessageError("subject", `at most ${SUBJECT_MAX} characters`);
  if (CONTROL.test(subject)) throw new GmailInvalidMessageError("subject", "must be a single line of text");

  const body = r.body;
  if (typeof body !== "string" || body.trim().length === 0) throw new GmailInvalidMessageError("body", "a message body is required");
  if (body.length > BODY_MAX) throw new GmailInvalidMessageError("body", `at most ${BODY_MAX} characters`);
  // eslint-disable-next-line no-control-regex
  if (/\u0000/.test(body)) throw new GmailInvalidMessageError("body", "must be plain text");

  let inReplyTo: GmailSendRequest["inReplyTo"];
  if (r.inReplyTo !== undefined && r.inReplyTo !== null) {
    const x = r.inReplyTo as Record<string, unknown>;
    if (
      typeof r.inReplyTo !== "object" || Array.isArray(r.inReplyTo) ||
      typeof x.threadId !== "string" || !ID_SHAPE.test(x.threadId) ||
      typeof x.messageId !== "string" || !ID_SHAPE.test(x.messageId)
    ) {
      throw new GmailInvalidMessageError("inReplyTo", "must be { threadId, messageId } of the message being answered");
    }
    inReplyTo = { threadId: x.threadId, messageId: x.messageId };
  }

  return { to: toOut, ...(ccOut.length ? { cc: ccOut } : {}), subject, body, ...(inReplyTo ? { inReplyTo } : {}) };
}

/** The number of distinct recipients of a validated request (the only figure the activity row keeps). */
export function recipientCount(req: GmailSendRequest): number {
  return req.to.length + (req.cc?.length ?? 0);
}
