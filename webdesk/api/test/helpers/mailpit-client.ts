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
  for (;;) {
    const messages = await mailpitSearch(query);
    if (messages.length > 0) return messages[0];
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for a Mailpit message matching "${query}"`);
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
