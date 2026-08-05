// MAIL-16D — EXECUTABLE PROOF that contract.ts is provider-agnostic, not just an architectural
// claim. This file defines a SECOND `GmailClient` implementation — deliberately built differently
// from fixture-client.ts (a `Map`-keyed store instead of arrays + `.find`, single-page pagination
// with no follow-page support at all, a different opaque pageToken encoding, its own independent
// small corpus with different ids/content) — and runs the exact same `runGmailClientContractTests`
// import against it. If the suite needed to know anything fixture-specific to pass, this file
// would fail; it does not change contract.ts, only supplies a different harness, which is exactly
// the shape MAIL-16's live adapter will use at staging.
import { GmailNotFoundError, GmailRateLimitedError, GmailRevokedError, GmailUnauthorizedError } from "./errors";
import { runGmailClientContractTests } from "./contract";
import type { GmailClient, GmailLabel, GmailMessage, GmailThread, GmailThreadPage } from "./types";

// A tiny, self-contained corpus with NOTHING in common with fixture-client.ts's ids/snippets/dates —
// proving the suite never leaked a fixture-specific literal into its assertions.
const ALT_LABELS: GmailLabel[] = [{ id: "lbl-primary", name: "Primary", type: "system" }];

const ALT_MESSAGES = new Map<string, GmailMessage>([
  [
    "alt-msg-1",
    {
      id: "alt-msg-1",
      threadId: "alt-thread-1",
      labelIds: ["lbl-primary"],
      headers: { from: "a@alt.invalid", to: "b@alt.invalid", subject: "alt subject", date: "2026-01-01T00:00:00.000Z" },
      parts: [{ mimeType: "text/plain", body: "alternate implementation body" }],
      attachments: [{ attachmentId: "alt-att-1", filename: "alt.txt", mimeType: "text/plain", sizeBytes: 7 }],
    },
  ],
]);

const ALT_THREADS = new Map<string, GmailThread>([
  ["alt-thread-1", { id: "alt-thread-1", labelIds: ["lbl-primary"], messages: [] }],
]);

/** A single-page-only implementation — `supportsPagination: false` in the harness below, so the
 *  suite's multi-page assertions self-skip via that flag rather than this implementation needing to
 *  fabricate a second page. A garbage token still 404s, matching the interface's own contract. */
class AlternateGmailClient implements GmailClient {
  async listThreads(pageToken?: string): Promise<GmailThreadPage> {
    if (pageToken !== undefined) throw new GmailNotFoundError("thread", `alt-page-token:${pageToken}`);
    return {
      threads: [
        {
          id: "alt-thread-1",
          snippet: "alternate implementation body",
          labelIds: ["lbl-primary"],
          messageIds: ["alt-msg-1"],
          lastMessageDate: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextPageToken: undefined,
    };
  }

  async getThread(threadId: string): Promise<GmailThread> {
    const t = ALT_THREADS.get(threadId);
    if (!t) throw new GmailNotFoundError("thread", threadId);
    const m = ALT_MESSAGES.get("alt-msg-1")!;
    return {
      id: t.id,
      labelIds: t.labelIds,
      messages: [
        { id: m.id, snippet: m.parts[0].body.slice(0, 120), labelIds: m.labelIds, messageIds: [m.id], lastMessageDate: m.headers.date },
      ],
    };
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
    const m = ALT_MESSAGES.get(messageId);
    if (!m) throw new GmailNotFoundError("message", messageId);
    return m;
  }

  async listLabels(): Promise<GmailLabel[]> {
    return ALT_LABELS;
  }
}

class AlternateThrowingClient implements GmailClient {
  constructor(private readonly make: () => Error) {}
  async listThreads(): Promise<GmailThreadPage> {
    throw this.make();
  }
  async getThread(): Promise<GmailThread> {
    throw this.make();
  }
  async getMessage(): Promise<GmailMessage> {
    throw this.make();
  }
  async listLabels(): Promise<GmailLabel[]> {
    throw this.make();
  }
}

runGmailClientContractTests("AlternateGmailClient (proof of implementation-agnosticism)", () => ({
  client: new AlternateGmailClient(),
  knownThreadId: "alt-thread-1",
  knownMessageId: "alt-msg-1",
  knownLabelName: "Primary",
  unknownId: "alt-does-not-exist",
  supportsPagination: false,
  createUnauthorizedClient: () => new AlternateThrowingClient(() => new GmailUnauthorizedError({ simulated: true })),
  createRevokedClient: () => new AlternateThrowingClient(() => new GmailRevokedError({ simulated: true })),
  createRateLimitedClient: () => new AlternateThrowingClient(() => new GmailRateLimitedError(15, { simulated: true })),
}));
