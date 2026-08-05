// MAIL-16D — the fixture-backed `GmailClient`. Reads a committed, static corpus (fixtures/*.json)
// and serves it through the seam's interface. Design M14 ("render on demand, cache nothing") is
// PRE-ENFORCED here structurally, not just by convention: this file performs no disk writes and no
// database access, and has no cache/module-level mutable store that survives a request — every
// method reads the frozen in-memory arrays loaded at import time and returns a value; nothing is
// ever written back anywhere. See gmail.zero-persistence.test.ts for the executable check.
//
// PAGINATION TOKEN FORMAT IS FIXTURE-SPECIFIC, DELIBERATELY OPAQUE. `GmailClient.listThreads`'s
// contract only promises "an opaque token you got from a previous page, or none for the first
// page" — it does NOT promise a token shape, because Gmail's real `nextPageToken` is an opaque
// string minted by Google and this seam must not invent a compatible-looking encoding a caller
// could be tempted to parse. This implementation's tokens (`fixture:v1:<offset>`) are only ever
// produced and consumed by THIS class; the contract suite (contract.ts) never inspects a token's
// contents, only that round-tripping it advances the list and that a garbage token 404s.
import type {
  GmailClient,
  GmailLabel,
  GmailMessage,
  GmailMessagePart,
  GmailThread,
  GmailThreadPage,
  GmailThreadSummary,
} from "./types";
import { GmailNotFoundError, GmailRateLimitedError, GmailRevokedError, GmailUnauthorizedError } from "./errors";

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

function encodeToken(offset: number): string {
  return `${TOKEN_PREFIX}${offset}`;
}

/** Returns the offset, or `null` for a token this implementation cannot make sense of — the caller
 *  (`listThreads`) turns `null` into a 404, which is the correct disposition for "a caller round-
 *  tripped a token from a DIFFERENT implementation" (e.g. a live-adapter token handed to the
 *  fixture client by mistake) — not a crash, and not silently restarting at page one. */
function decodeToken(token: string): number | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const raw = token.slice(TOKEN_PREFIX.length);
  const offset = Number(raw);
  if (!Number.isInteger(offset) || offset < 0 || offset > THREADS.length) return null;
  return offset;
}

export interface GmailFixtureClientOptions {
  /** Threads per page. Default 2, deliberately small so the 5-thread fixture corpus exercises
   *  more than one page without a caller having to configure anything. */
  pageSize?: number;
}

export class GmailFixtureClient implements GmailClient {
  private readonly pageSize: number;

  constructor(opts: GmailFixtureClientOptions = {}) {
    this.pageSize = opts.pageSize ?? 2;
  }

  async listThreads(pageToken?: string): Promise<GmailThreadPage> {
    const offset = pageToken === undefined ? 0 : decodeToken(pageToken);
    if (offset === null) throw new GmailNotFoundError("thread", `page-token:${pageToken}`);

    const page = THREADS.slice(offset, offset + this.pageSize);
    const nextOffset = offset + this.pageSize;
    return {
      threads: page,
      nextPageToken: nextOffset < THREADS.length ? encodeToken(nextOffset) : undefined,
    };
  }

  async getThread(threadId: string): Promise<GmailThread> {
    const summary = THREADS.find((t) => t.id === threadId);
    if (!summary) throw new GmailNotFoundError("thread", threadId);
    const messages = summary.messageIds.map((id) => {
      const m = MESSAGES.find((msg) => msg.id === id);
      if (!m) throw new GmailNotFoundError("message", id); // corpus-integrity guard, not reachable via a caller id
      return messageToSummary(m);
    });
    return { id: summary.id, labelIds: summary.labelIds, messages };
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
    const m = MESSAGES.find((msg) => msg.id === messageId);
    if (!m) throw new GmailNotFoundError("message", messageId);
    return m;
  }

  async listLabels(): Promise<GmailLabel[]> {
    return LABELS;
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
