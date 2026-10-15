import "server-only";
// DW-8j UI: the readers behind /me/mail (BFF §48). Each returns a `ReadResult`: a 403 is `forbidden` (the viewer has no mailbox), every
// other failure is `unavailable` with a sentence, never an empty mailbox. Nothing is cached: each call reads again.
import { platformFetch, PlatformError } from "./platform";
import type { ReadResult } from "./readResult";
import {
  gmailErrorText, normalizeStatus, normalizeThread, normalizeThreadList, statusPath, threadPath, threadsPath,
  type GmailStatus, type MailLabel, type MailThread, type ThreadList,
} from "./gmail";

/** The failure as a `ReadResult`: 403 is forbidden, anything else is a sentence (the status and the tokens decide the words). */
export function gmailFailure<T>(err: unknown): ReadResult<T> {
  if (err instanceof PlatformError) {
    if (err.status === 403) return { kind: "forbidden" };
    const retry = (err.body as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
    return {
      kind: "unavailable",
      reason: gmailErrorText({
        status: err.status, error: err.message, reason: err.reason, field: err.field,
        retryAfterSeconds: typeof retry === "number" ? retry : null,
      }),
    };
  }
  return { kind: "unavailable", reason: gmailErrorText({ status: 502 }) };
}

async function read<T>(p: Promise<unknown>, normalize: (raw: unknown) => T | null): Promise<ReadResult<T>> {
  try {
    const v = normalize(await p);
    return v ? { kind: "ok", data: v } : { kind: "unavailable", reason: "The platform answered in a way we couldn't read. Reload the page." };
  } catch (e) {
    return gmailFailure<T>(e);
  }
}

/** `GET integrations/gmail`: the token-free status. It is gated by `connect`, so a viewer gets 403 (no mailbox). */
export const readGmailStatus = (u: string, t: string): Promise<ReadResult<GmailStatus>> =>
  read(platformFetch<unknown>(statusPath(t), u), normalizeStatus);

export const readThreads = (u: string, t: string, label: MailLabel, pageToken?: string | null): Promise<ReadResult<ThreadList>> =>
  read(platformFetch<unknown>(threadsPath(t, label, pageToken), u), normalizeThreadList);

export const readThread = (u: string, t: string, threadId: string): Promise<ReadResult<MailThread>> =>
  read(platformFetch<unknown>(threadPath(t, threadId), u), normalizeThread);
