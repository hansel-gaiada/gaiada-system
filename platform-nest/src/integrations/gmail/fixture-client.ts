// MAIL-16D — the fixture-backed `GmailClient`. Reads a committed, static corpus (fixtures/*.json)
// and serves it through the seam's interface. Design M14 ("render on demand, cache nothing") is
// PRE-ENFORCED here structurally, not just by convention: this file performs no disk writes and no
// database access, and has no cache/module-level mutable store that survives a request — every
// method reads the frozen in-memory arrays loaded at import time and returns a value; nothing is
// ever written back anywhere. See gmail.zero-persistence.test.ts for the executable check.
//
// DW-8j (DW-D24) — THIS CLIENT NOW ALSO BACKS THE SIMULATED MAILBOX. `sendMessage` appends to an in-process `sent` list that the CALLER
// owns (core/gmail's simulated mode hands each person their own, see simulated-mailboxes.ts): nothing is written to disk or a database,
// nothing is sent over a network (this file imports no network or mail library and calls no `fetch`; gmail.simulated-isolation.test.ts
// scans for exactly that), and the list dies with the process. The corpus itself stays frozen and read-only. A reply keeps the thread:
// the sent message joins the fixture thread it answers, and the thread views (`getThread`, the INBOX list's `messageIds`) include it.
//
// PAGINATION TOKEN FORMAT IS FIXTURE-SPECIFIC, DELIBERATELY OPAQUE. `GmailClient.listThreads`'s
// contract only promises "an opaque token you got from a previous page, or none for the first
// page" — it does NOT promise a token shape, because Gmail's real `nextPageToken` is an opaque
// string minted by Google and this seam must not invent a compatible-looking encoding a caller
// could be tempted to parse. This implementation's tokens (`fixture:v1:<offset>`, and
// `fixture:v1:sent:<offset>` for the SENT view) are only ever produced and consumed by THIS class;
// the contract suite (contract.ts) never inspects a token's contents, only that round-tripping it
// advances the list and that a garbage token 404s.
import { randomUUID } from "node:crypto";
import type {
  GmailClient,
  GmailLabel,
  GmailListOptions,
  GmailMessage,
  GmailMessagePart,
  GmailSendRequest,
  GmailSendResult,
  GmailThread,
  GmailThreadPage,
  GmailThreadSummary,
} from "./types";
import {
  GmailInvalidMessageError,
  GmailNotFoundError,
  GmailRateLimitedError,
  GmailRevokedError,
  GmailUnauthorizedError,
} from "./errors";
import { validateSendRequest } from "./send-validation";

import labelsFixture from "./fixtures/labels.json";
import messagesFixture from "./fixtures/messages.json";
import threadsFixture from "./fixtures/threads.json";

// Re-typed from the raw JSON import so callers of this module see the seam's own types, not
// `any[]` — the JSON files are the single source of truth; these casts are the only place that
// trusts their shape.
const THREADS = threadsFixture as GmailThreadSummary[];
const MESSAGES = messagesFixture as GmailMessage[];
const LABELS = labelsFixture as GmailLabel[];

const TOKEN_PREFIX = "fixture:v1:";
const SENT_TOKEN_PREFIX = "fixture:v1:sent:";

function encodeToken(offset: number, label: "INBOX" | "SENT" = "INBOX"): string {
  return `${label === "SENT" ? SENT_TOKEN_PREFIX : TOKEN_PREFIX}${offset}`;
}

/** Returns the offset, or `null` for a token this implementation cannot make sense of for the requested `label`, or whose offset is out
 *  of range for a list of `length` — the caller (`listThreads`) turns `null` into a 404, which is the correct disposition for "a caller
 *  round-tripped a token from a DIFFERENT implementation" (e.g. a live-adapter token handed to the fixture client by mistake, or an INBOX
 *  token replayed against the SENT list) — not a crash, and not silently restarting at page one. */
function decodeToken(token: string, label: "INBOX" | "SENT", length: number): number | null {
  const prefix = label === "SENT" ? SENT_TOKEN_PREFIX : TOKEN_PREFIX;
  if (!token.startsWith(prefix)) return null;
  const raw = token.slice(prefix.length);
  if (!/^\d+$/.test(raw)) return null; // `fixture:v1:sent:2` is not an INBOX offset, and an INBOX token is not a SENT one
  const offset = Number(raw);
  if (!Number.isInteger(offset) || offset < 0 || offset > length) return null;
  return offset;
}

/** The most messages one simulated mailbox's Sent keeps; the oldest is dropped past it, so a runaway sender cannot grow the process. */
export const SIMULATED_SENT_CAP = 500;

export interface GmailFixtureClientOptions {
  /** Threads per page. Default 2, deliberately small so the 5-thread fixture corpus exercises
   *  more than one page without a caller having to configure anything. */
  pageSize?: number;
  /** DW-8j. The list this client's `sendMessage` appends to, owned by the caller so it outlives one request (the simulated mailbox of
   *  one person). Omitted: a private list that lives and dies with this instance. */
  sent?: GmailMessage[];
  /** DW-8j. The address sent mail is `from` (the simulated account). */
  accountEmail?: string;
  /** DW-8j. Injectable clock, for deterministic dates in tests. */
  now?: () => Date;
}

export class GmailFixtureClient implements GmailClient {
  private readonly pageSize: number;
  private readonly sent: GmailMessage[];
  private readonly accountEmail: string;
  private readonly now: () => Date;

  constructor(opts: GmailFixtureClientOptions = {}) {
    this.pageSize = opts.pageSize ?? 2;
    this.sent = opts.sent ?? [];
    this.accountEmail = opts.accountEmail ?? "staff@gaiada.invalid";
    this.now = opts.now ?? (() => new Date());
  }

  async listThreads(pageToken?: string, opts: GmailListOptions = {}): Promise<GmailThreadPage> {
    const label = opts.label ?? "INBOX";
    const all = label === "SENT" ? this.sentThreads() : THREADS.map((t) => this.withReplies(t));
    const offset = pageToken === undefined ? 0 : decodeToken(pageToken, label, all.length);
    if (offset === null) throw new GmailNotFoundError("thread", `page-token:${pageToken}`);

    const page = all.slice(offset, offset + this.pageSize);
    const nextOffset = offset + this.pageSize;
    return {
      threads: page,
      nextPageToken: nextOffset < all.length ? encodeToken(nextOffset, label) : undefined,
    };
  }

  async getThread(threadId: string): Promise<GmailThread> {
    const summary = THREADS.find((t) => t.id === threadId);
    const replies = this.sent.filter((m) => m.threadId === threadId);
    if (!summary) {
      if (replies.length === 0) throw new GmailNotFoundError("thread", threadId);
      return { id: threadId, labelIds: ["SENT"], messages: replies.map(messageToSummary) };
    }
    const messages = summary.messageIds.map((id) => {
      const m = MESSAGES.find((msg) => msg.id === id);
      if (!m) throw new GmailNotFoundError("message", id); // corpus-integrity guard, not reachable via a caller id
      return messageToSummary(m);
    });
    return { id: summary.id, labelIds: summary.labelIds, messages: [...messages, ...replies.map(messageToSummary)] };
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
    const m = MESSAGES.find((msg) => msg.id === messageId) ?? this.sent.find((msg) => msg.id === messageId);
    if (!m) throw new GmailNotFoundError("message", messageId);
    return m;
  }

  async listLabels(): Promise<GmailLabel[]> {
    return LABELS;
  }

  /** The simulated send: validates exactly as a live adapter must, then appends the message to this person's Sent (memory only). */
  async sendMessage(req: GmailSendRequest): Promise<GmailSendResult> {
    const v = validateSendRequest(req);
    let threadId = `sim-t-${randomUUID().slice(0, 12)}`;
    let inReplyTo: string | undefined;
    let references: string | undefined;
    if (v.inReplyTo) {
      const answered = v.inReplyTo;
      const parent = MESSAGES.find((m) => m.id === answered.messageId) ?? this.sent.find((m) => m.id === answered.messageId);
      if (!parent) throw new GmailNotFoundError("message", answered.messageId);
      const threadKnown = THREADS.some((t) => t.id === answered.threadId) || this.sent.some((m) => m.threadId === answered.threadId);
      if (!threadKnown) throw new GmailNotFoundError("thread", answered.threadId);
      if (parent.threadId !== answered.threadId) {
        throw new GmailInvalidMessageError("inReplyTo", "the message being answered is not in that thread");
      }
      threadId = parent.threadId;
      inReplyTo = `<${parent.id}@fixture.invalid>`;
      references = [parent.headers.references, inReplyTo].filter(Boolean).join(" ");
    }
    const id = `sim-m-${randomUUID().slice(0, 12)}`;
    const message: GmailMessage = {
      id,
      threadId,
      labelIds: ["SENT"],
      headers: {
        from: this.accountEmail,
        to: v.to.join(", "),
        ...(v.cc?.length ? { cc: v.cc.join(", ") } : {}),
        subject: v.subject,
        date: this.now().toISOString(),
        ...(inReplyTo ? { inReplyTo, references } : {}),
      },
      parts: [{ mimeType: "text/plain", body: v.body }],
      attachments: [],
    };
    this.sent.push(message);
    if (this.sent.length > SIMULATED_SENT_CAP) this.sent.splice(0, this.sent.length - SIMULATED_SENT_CAP);
    return { messageId: id, threadId };
  }

  /** A fixture thread with this person's sent replies folded in (so a reply is visible in the INBOX thread it answered). */
  private withReplies(t: GmailThreadSummary): GmailThreadSummary {
    const replies = this.sent.filter((m) => m.threadId === t.id);
    if (replies.length === 0) return t;
    const last = replies[replies.length - 1];
    return {
      ...t,
      messageIds: [...t.messageIds, ...replies.map((m) => m.id)],
      lastMessageDate: last.headers.date > t.lastMessageDate ? last.headers.date : t.lastMessageDate,
    };
  }

  /** The SENT view: one row per thread this person has sent into, newest first. */
  private sentThreads(): GmailThreadSummary[] {
    const byThread = new Map<string, GmailMessage[]>();
    for (const m of this.sent) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
    return [...byThread.entries()]
      .map(([id, msgs]) => {
        const last = msgs[msgs.length - 1];
        return {
          id,
          snippet: (last.parts[0]?.body ?? "").slice(0, 120),
          labelIds: ["SENT"],
          messageIds: msgs.map((m) => m.id),
          lastMessageDate: last.headers.date,
        };
      })
      .sort((a, b) => (a.lastMessageDate < b.lastMessageDate ? 1 : a.lastMessageDate > b.lastMessageDate ? -1 : 0));
  }
}

function messageToSummary(m: GmailMessage): GmailThreadSummary {
  const firstPart = m.parts.find((p: GmailMessagePart) => p.mimeType === "text/plain") ?? m.parts[0];
  return {
    id: m.id,
    snippet: firstPart ? firstPart.body.slice(0, 120) : "",
    labelIds: m.labelIds,
    messageIds: [m.id],
    lastMessageDate: m.headers.date,
  };
}

// ── Error-state factories ────────────────────────────────────────────────────────────────────────
// A fixture cannot make Google return a real 401/403/429 — those states are about the CALLER'S
// credential/quota, not about which thread/message id is requested. So this seam models them as
// alternate CLIENT INSTANCES whose every method rejects the same way, and the contract suite's
// harness asks each implementation for one of these instead of asserting on error internals
// (contract.ts's `GmailClientTestHarness`). The live adapter's own test file will supply the
// equivalent by pointing at a token/account it knows is unauthorized/revoked/throttled — the SUITE
// stays identical either way.

class ThrowingGmailClient implements GmailClient {
  constructor(private readonly makeError: () => Error) {}
  async listThreads(): Promise<GmailThreadPage> {
    throw this.makeError();
  }
  async getThread(): Promise<GmailThread> {
    throw this.makeError();
  }
  async getMessage(): Promise<GmailMessage> {
    throw this.makeError();
  }
  async listLabels(): Promise<GmailLabel[]> {
    throw this.makeError();
  }
  async sendMessage(): Promise<GmailSendResult> {
    throw this.makeError();
  }
}

export function createFixtureGmailClient(opts?: GmailFixtureClientOptions): GmailClient {
  return new GmailFixtureClient(opts);
}

export function createUnauthorizedFixtureGmailClient(): GmailClient {
  return new ThrowingGmailClient(() => new GmailUnauthorizedError({ simulated: true }));
}

export function createRevokedFixtureGmailClient(): GmailClient {
  return new ThrowingGmailClient(() => new GmailRevokedError({ simulated: true }));
}

export function createRateLimitedFixtureGmailClient(retryAfterSeconds = 30): GmailClient {
  return new ThrowingGmailClient(() => new GmailRateLimitedError(retryAfterSeconds, { simulated: true }));
}

/** Exported for the fixture's own tests + the zero-persistence check — not part of the seam
 *  interface, so it is not re-exported from an index barrel. */
export const FIXTURE_KNOWN_THREAD_ID = THREADS[0].id;
export const FIXTURE_KNOWN_MESSAGE_ID = MESSAGES[0].id;
export const FIXTURE_KNOWN_LABEL_NAME = LABELS[0].name;
export const FIXTURE_UNKNOWN_ID = "does-not-exist-in-the-fixture-corpus";
export const FIXTURE_THREAD_COUNT = THREADS.length;
