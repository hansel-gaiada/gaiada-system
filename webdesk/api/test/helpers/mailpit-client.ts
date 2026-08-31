// WSK-11 test helper — Mailpit's HTTP API is the evidence surface (same convention the Zone A
// mail doctrine's A11 decision uses: "scriptable assertions, not screenshots"). NEW file, does
// not touch any existing helper.
const BASE_URL = process.env.MAILPIT_HTTP_URL || "http://localhost:55453";

export type MailpitMessageSummary = { ID: string; To: { Address: string }[]; Subject: string };

export type MailpitMessageDetail = {
  ID: string;
  From: { Address: string; Name: string };
  To: { Address: string; Name: string }[];
  ReplyTo: { Address: string; Name: string }[];
  Subject: string;
  HTML: string;
  Text: string;
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`Mailpit API ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export async function mailpitReset(): Promise<void> {
  await fetch(`${BASE_URL}/api/v1/messages`, { method: "DELETE" });
}

export async function mailpitSearch(query: string): Promise<MailpitMessageSummary[]> {
  const data = await get<{ messages: MailpitMessageSummary[] }>(
    `/api/v1/search?query=${encodeURIComponent(query)}`,
  );
  return data.messages;
}

export async function mailpitGetMessage(id: string): Promise<MailpitMessageDetail> {
  return get<MailpitMessageDetail>(`/api/v1/message/${id}`);
}

/** Polls Mailpit's search API until at least one message matching `query` shows up, or times out. */
export async function waitForMailpitMessage(
  query: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<MailpitMessageSummary> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  // A CONNECTION ERROR IS "NOT READY YET", NOT A FAILURE. `mail-retry-backoff` proves retry and
  // backoff by STOPPING a real Mailpit container and starting it again, so this loop is guaranteed
  // to poll a sink that is down — and `docker start` returns before the port is re-bound, which on
  // a CI runner is slow enough to matter and on a warm laptop usually is not. Rethrowing the first
  // `fetch failed` aborted the whole wait and surfaced as a bare "fetch failed" with nothing naming
  // Mailpit. The DEADLINE stays the only thing that fails this helper; the last error is carried
  // into that message so a genuinely-unreachable sink is still diagnosable.
  let lastError: unknown;
  for (;;) {
    try {
      const messages = await mailpitSearch(query);
      if (messages.length > 0) return messages[0];
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      const because = lastError ? ` (last error: ${(lastError as Error).message})` : "";
      throw new Error(`timed out waiting for a Mailpit message matching "${query}"${because}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Explicitly asserts NO message matching `query` shows up within a short observation window —
 * the suppression-must-block-delivery proof needs a bounded "nothing happened" check, not just
 * the absence of a positive result at one instant. */
export async function assertNoMailpitMessage(query: string, observeMs = 2_000): Promise<void> {
  const deadline = Date.now() + observeMs;
  while (Date.now() < deadline) {
    const messages = await mailpitSearch(query);
    if (messages.length > 0) {
      throw new Error(`expected NO Mailpit message matching "${query}", found ${messages.length}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
