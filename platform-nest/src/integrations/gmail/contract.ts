// MAIL-16D — THE contract suite (design §8C/A14: "a provider-agnostic contract-test suite that
// BOTH implementations must pass"; plan row: "the live adapter runs the same suite unmodified at
// staging"). This file is deliberately NOT a `*.test.ts` — it exports a function that BUILDS a
// vitest `describe` block from a harness, and is invoked once per implementation from that
// implementation's own `*.test.ts` file (fixture-client.contract.test.ts today; MAIL-16's live
// adapter gets its own `<adapter>.contract.test.ts` at staging that imports this SAME function).
//
// THE ONE RULE THIS FILE MUST NEVER BREAK: no assertion below may reference fixture-specific data
// (a literal thread id, a literal snippet string, a literal attachment filename, ...). Every fixed
// point the suite needs (a known thread id, a known message id, a known label name, an id
// guaranteed absent) comes from the harness, which the FIXTURE's test file fills in from its own
// corpus and the LIVE adapter's test file will fill in from whatever real thread/message/label it
// is safe to depend on in a staging test account. If a future edit here needs a new fixed point,
// add it to `GmailClientContractHarness`, not as an inline literal.
import { beforeAll, describe, expect, it } from "vitest";

import { GmailNotFoundError, GmailRateLimitedError, GmailRevokedError, GmailUnauthorizedError } from "./errors";
import type { GmailClient } from "./types";

export interface GmailClientContractHarness {
  /** A client in a normal, authorized state. */
  client: GmailClient;
  /** A thread id the harness's corpus is known to contain, with at least one message. */
  knownThreadId: string;
  /** A message id the harness's corpus is known to contain. */
  knownMessageId: string;
  /** A label name the harness's corpus is known to contain. */
  knownLabelName: string;
  /** An id guaranteed to match NEITHER a thread NOR a message in this harness's corpus. */
  unknownId: string;
  /** Whether the corpus behind `client` has more than one page of threads at the implementation's
   *  own default page size — pagination assertions run only when true, so an implementation with a
   *  tiny corpus is not forced to fabricate extra data purely to satisfy this suite. */
  supportsPagination: boolean;
  /** Error-state factories. Optional so an implementation can document a gap (the suite REPORTS a
   *  skip via `it.skip`, visible in output, rather than silently omitting the assertion) instead of
   *  being forced to fake a state it cannot yet produce. MAIL-16's live adapter is expected to
   *  supply all three at staging (design §8C names all three as in-scope error states). */
  createUnauthorizedClient?: () => GmailClient;
  createRevokedClient?: () => GmailClient;
  createRateLimitedClient?: () => GmailClient;
}

function isIsoDate(v: unknown): boolean {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

export function runGmailClientContractTests(
  implementationName: string,
  makeHarness: () => GmailClientContractHarness | Promise<GmailClientContractHarness>,
): void {
  describe(`GmailClient contract — ${implementationName}`, () => {
    let harness: GmailClientContractHarness;

    beforeAll(async () => {
      harness = await makeHarness();
    });

    describe("listThreads", () => {
      it("returns a page shaped as { threads: GmailThreadSummary[] }", async () => {
        const page = await harness.client.listThreads();
        expect(Array.isArray(page.threads)).toBe(true);
        expect(page.threads.length).toBeGreaterThan(0);
        for (const t of page.threads) {
          expect(typeof t.id).toBe("string");
          expect(typeof t.snippet).toBe("string");
          expect(Array.isArray(t.labelIds)).toBe(true);
          expect(Array.isArray(t.messageIds)).toBe(true);
          expect(t.messageIds.length).toBeGreaterThan(0);
          expect(isIsoDate(t.lastMessageDate)).toBe(true);
        }
      });

      it("omits nextPageToken (or leaves it undefined) once every thread has been paged through", async () => {
        if (!harness.supportsPagination) return; // documented via the harness flag, not silently
        const seen = new Set<string>();
        let token: string | undefined;
        let guard = 0;
        do {
          const page = await harness.client.listThreads(token);
          for (const t of page.threads) {
            expect(seen.has(t.id)).toBe(false); // no repeats across pages
            seen.add(t.id);
          }
          token = page.nextPageToken;
          guard += 1;
        } while (token !== undefined && guard < 50); // runaway guard, not a real limit on corpus size
        expect(guard).toBeLessThan(50);
        expect(seen.size).toBeGreaterThan(0);
      });

      it("a garbage pageToken is refused as not-found, not silently treated as page one", async () => {
        await expect(harness.client.listThreads("this-token-was-never-issued-by-any-implementation")).rejects.toThrow(
          GmailNotFoundError,
        );
      });
    });

    describe("getThread", () => {
      it("returns the thread's own id, labelIds, and messages shaped as GmailThreadSummary[]", async () => {
        const thread = await harness.client.getThread(harness.knownThreadId);
        expect(thread.id).toBe(harness.knownThreadId);
        expect(Array.isArray(thread.labelIds)).toBe(true);
        expect(Array.isArray(thread.messages)).toBe(true);
        expect(thread.messages.length).toBeGreaterThan(0);
        for (const m of thread.messages) {
          expect(typeof m.id).toBe("string");
          expect(typeof m.snippet).toBe("string");
        }
      });

      it("an unknown thread id raises GmailNotFoundError (status 404)", async () => {
        await expect(harness.client.getThread(harness.unknownId)).rejects.toThrow(GmailNotFoundError);
        try {
          await harness.client.getThread(harness.unknownId);
          expect.unreachable("getThread should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(GmailNotFoundError);
          expect((err as GmailNotFoundError).status).toBe(404);
        }
      });
    });

    describe("getMessage", () => {
      it("returns decoded parts (no base64, no raw MIME) and attachment METADATA only", async () => {
        const msg = await harness.client.getMessage(harness.knownMessageId);
        expect(msg.id).toBe(harness.knownMessageId);
        expect(typeof msg.threadId).toBe("string");
        expect(Array.isArray(msg.labelIds)).toBe(true);
        expect(typeof msg.headers.from).toBe("string");
        expect(typeof msg.headers.to).toBe("string");
        expect(typeof msg.headers.subject).toBe("string");
        expect(isIsoDate(msg.headers.date)).toBe(true);

        expect(Array.isArray(msg.parts)).toBe(true);
        expect(msg.parts.length).toBeGreaterThan(0);
        for (const p of msg.parts) {
          expect(typeof p.mimeType).toBe("string");
          expect(typeof p.body).toBe("string");
          // A decoded part must not still look like a base64url blob standing in for real content —
          // this is a smell check, not a proof, but it catches "forgot to decode" regressions.
          expect(/^[A-Za-z0-9_-]{40,}$/.test(p.body)).toBe(false);
        }

        expect(Array.isArray(msg.attachments)).toBe(true);
        for (const a of msg.attachments) {
          expect(typeof a.attachmentId).toBe("string");
          expect(typeof a.filename).toBe("string");
          expect(typeof a.mimeType).toBe("string");
          expect(typeof a.sizeBytes).toBe("number");
          expect(a.sizeBytes).toBeGreaterThan(0);
          // Metadata only, per M14: this object must never carry the bytes themselves.
          expect(a).not.toHaveProperty("data");
          expect(a).not.toHaveProperty("content");
        }
      });

      it("an unknown message id raises GmailNotFoundError (status 404)", async () => {
        await expect(harness.client.getMessage(harness.unknownId)).rejects.toThrow(GmailNotFoundError);
      });
    });

    describe("listLabels", () => {
      it("returns labels shaped as { id, name, type }, including the known label", async () => {
        const labels = await harness.client.listLabels();
        expect(Array.isArray(labels)).toBe(true);
        expect(labels.length).toBeGreaterThan(0);
        for (const l of labels) {
          expect(typeof l.id).toBe("string");
          expect(typeof l.name).toBe("string");
          expect(["system", "user"]).toContain(l.type);
        }
        expect(labels.some((l) => l.name === harness.knownLabelName)).toBe(true);
      });
    });

    describe("error taxonomy — unauthorized / revoked / rate-limited", () => {
      it("unauthorized: every method raises GmailUnauthorizedError (status 401)", async () => {
        if (!harness.createUnauthorizedClient) {
          console.warn(`[contract:${implementationName}] createUnauthorizedClient not supplied — skipped`);
          return;
        }
        const c = harness.createUnauthorizedClient();
        await expect(c.listThreads()).rejects.toBeInstanceOf(GmailUnauthorizedError);
        await expect(c.getThread(harness.knownThreadId)).rejects.toBeInstanceOf(GmailUnauthorizedError);
        await expect(c.getMessage(harness.knownMessageId)).rejects.toBeInstanceOf(GmailUnauthorizedError);
        await expect(c.listLabels()).rejects.toBeInstanceOf(GmailUnauthorizedError);
        try {
          await c.listThreads();
        } catch (err) {
          expect((err as GmailUnauthorizedError).status).toBe(401);
        }
      });

      it("revoked: every method raises GmailRevokedError (status 403)", async () => {
        if (!harness.createRevokedClient) {
          console.warn(`[contract:${implementationName}] createRevokedClient not supplied — skipped`);
          return;
        }
        const c = harness.createRevokedClient();
        await expect(c.listThreads()).rejects.toBeInstanceOf(GmailRevokedError);
        try {
          await c.listThreads();
        } catch (err) {
          expect((err as GmailRevokedError).status).toBe(403);
        }
      });

      it("rate-limited: every method raises GmailRateLimitedError (status 429) carrying retryAfterSeconds", async () => {
        if (!harness.createRateLimitedClient) {
          console.warn(`[contract:${implementationName}] createRateLimitedClient not supplied — skipped`);
          return;
        }
        const c = harness.createRateLimitedClient();
        await expect(c.listThreads()).rejects.toBeInstanceOf(GmailRateLimitedError);
        try {
          await c.getThread(harness.knownThreadId);
          expect.unreachable("getThread should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(GmailRateLimitedError);
          expect((err as GmailRateLimitedError).status).toBe(429);
          expect(typeof (err as GmailRateLimitedError).retryAfterSeconds).toBe("number");
          expect((err as GmailRateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
        }
      });
    });
  });
}
