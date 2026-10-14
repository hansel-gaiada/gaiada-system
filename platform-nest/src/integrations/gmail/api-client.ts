// DW-8j (DW-D24, docs/FRONTEND-BFF-CONTRACT.md §48.1) — the LIVE `GmailClient`: the real Gmail REST API with ONE person's own access token.
// Selected by core/gmail only when GMAIL_MODE=live. NOT exercised against Google in this ticket (no network in tests): api-client.test.ts
// drives it with a stubbed `fetch`, and the provider-agnostic contract suite (contract.ts) must pass against it UNMODIFIED at staging
// (DW-11), through a sibling `api-client.contract.test.ts` that supplies a harness built from a staging account.
//
// SCOPES (§48.1): gmail.readonly for the reads, gmail.send for `sendMessage`. Nothing here ever stores anything: it holds the token for the
// life of one request and returns decoded values.
//
// WHAT IT NEVER DOES: put the token, a request header or a response body into an error. Every error carries a status and a stable code
// (errors.ts); `detail` holds at most the HTTP status and Google's machine `reason`.
//
// UNVERIFIED against real Google (README "Honesty note"): the MIME-tree walk, the `threads.list` + per-thread metadata fan-out and the
// quota reasons mapped to a rate-limit are written from Google's documented shapes, not from a live response.
import { GmailInvalidMessageError, GmailNotFoundError, GmailRateLimitedError, GmailRevokedError, GmailUnauthorizedError, GmailUnavailableError } from "./errors";
import { validateSendRequest } from "./send-validation";
import type {
  GmailAttachmentMeta,
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

/** The slice of `fetch` this client uses: the global one satisfies it, and a test hands in a stub. */
export type GmailFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface GmailApiClientOptions {
  accessToken: string;
  fetchImpl?: GmailFetch;
  /** Default `https://gmail.googleapis.com/gmail/v1/users/me`. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Threads per list page (Google's `maxResults`). Default 20. */
  pageSize?: number;
}

const DEFAULT_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const QUOTA_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded"]);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

interface ApiMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: ApiPart;
}
interface ApiPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: ApiPart[];
}

const decodeEntities = (s: string): string =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const b64urlDecode = (s: string): string => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const b64urlEncode = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const isoOf = (internalDate: string | undefined): string => {
  const ms = Number(internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date(0).toISOString();
};

/** RFC 2047: an ASCII subject goes as is; anything else becomes encoded-words of at most 75 characters each (chunked on UTF-8 bytes). */
export function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const ch of subject) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > 42) {
      words.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += ch;
    bytes += n;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** The RFC 5322 text of a plain-text message. Exported for the unit test; the only place a header is built. */
export function buildRawMessage(req: GmailSendRequest, parent?: { messageIdHeader: string; references: string }): string {
  const lines = [`To: ${req.to.join(", ")}`];
  if (req.cc?.length) lines.push(`Cc: ${req.cc.join(", ")}`);
  lines.push(`Subject: ${encodeSubject(req.subject)}`);
  if (parent) {
    lines.push(`In-Reply-To: ${parent.messageIdHeader}`);
    lines.push(`References: ${[parent.references, parent.messageIdHeader].filter(Boolean).join(" ")}`);
  }
  lines.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "");
  const body64 = Buffer.from(req.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return `${lines.join("\r\n")}\r\n${body64}`;
}

export class GmailApiClient implements GmailClient {
  private readonly fetchImpl: GmailFetch;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly pageSize: number;

  constructor(private readonly opts: GmailApiClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as GmailFetch);
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.pageSize = opts.pageSize ?? 20;
  }

  // ── transport ───────────────────────────────────────────────────────────────────────────────
  private async call<T>(
    method: "GET" | "POST",
    path: string,
    q: Record<string, string | string[] | undefined> = {},
    body?: unknown,
    onBadRequest?: () => Error,
    notFound?: () => Error,
  ): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
    }
    let res: Awaited<ReturnType<GmailFetch>>;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers: { authorization: `Bearer ${this.opts.accessToken}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GmailUnavailableError({ cause: "network" });
    }
    const text = await res.text().catch(() => "");
    if (res.status >= 200 && res.status < 300) {
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new GmailUnavailableError({ status: res.status, cause: "unparseable" });
      }
    }
    let reason = "";
    try {
      const parsed = JSON.parse(text) as { error?: { errors?: Array<{ reason?: string }> } };
      reason = parsed.error?.errors?.[0]?.reason ?? "";
    } catch {
      /* a non-JSON error body: the status alone decides */
    }
    if (res.status === 401) throw new GmailUnauthorizedError({ status: 401 });
    if (res.status === 429 || (res.status === 403 && QUOTA_REASONS.has(reason))) {
      const retry = Number(res.headers.get("retry-after"));
      throw new GmailRateLimitedError(Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 60, { status: res.status, reason });
    }
    if (res.status === 403) throw new GmailRevokedError({ status: 403, reason });
    if (res.status === 404 && notFound) throw notFound();
    if (res.status === 400 && onBadRequest) throw onBadRequest();
    throw new GmailUnavailableError({ status: res.status, reason });
  }

  // ── reads ───────────────────────────────────────────────────────────────────────────────────
  async listThreads(pageToken?: string, opts: GmailListOptions = {}): Promise<GmailThreadPage> {
    const list = await this.call<{ threads?: Array<{ id: string; snippet?: string }>; nextPageToken?: string }>(
      "GET", "/threads",
      { maxResults: String(this.pageSize), labelIds: opts.label ?? "INBOX", pageToken },
      undefined,
      () => new GmailNotFoundError("thread", "page-token"),
    );
    // threads.list names a thread and its snippet only; the ids, labels and date of a row come from one minimal read per thread.
    const threads = await Promise.all(
      (list.threads ?? []).map(async (t): Promise<GmailThreadSummary> => {
        const full = await this.readThread(t.id);
        return { ...full, snippet: decodeEntities(t.snippet ?? full.snippet) };
      }),
    );
    return { threads, nextPageToken: list.nextPageToken || undefined };
  }

  /** One thread, as a list-row summary (the union of its messages' labels, every message id oldest-first, the last message's date). */
  private async readThread(id: string): Promise<GmailThreadSummary> {
    const t = await this.call<{ id?: string; messages?: ApiMessage[] }>(
      "GET", `/threads/${encodeURIComponent(id)}`, { format: "minimal" }, undefined, undefined, () => new GmailNotFoundError("thread", id),
    );
    const msgs = t.messages ?? [];
    const last = msgs[msgs.length - 1];
    return {
      id: t.id ?? id,
      snippet: decodeEntities(last?.snippet ?? ""),
      labelIds: [...new Set(msgs.flatMap((m) => m.labelIds ?? []))],
      messageIds: msgs.map((m) => m.id ?? "").filter(Boolean),
      lastMessageDate: isoOf(last?.internalDate),
    };
  }

  async getThread(threadId: string): Promise<GmailThread> {
    const t = await this.call<{ id?: string; messages?: ApiMessage[] }>(
      "GET", `/threads/${encodeURIComponent(threadId)}`, { format: "minimal" }, undefined, undefined, () => new GmailNotFoundError("thread", threadId),
    );
    const msgs = t.messages ?? [];
    return {
      id: t.id ?? threadId,
      labelIds: [...new Set(msgs.flatMap((m) => m.labelIds ?? []))],
      messages: msgs.map((m) => ({
        id: m.id ?? "",
        snippet: decodeEntities(m.snippet ?? ""),
        labelIds: m.labelIds ?? [],
        messageIds: [m.id ?? ""],
        lastMessageDate: isoOf(m.internalDate),
      })),
    };
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
    const m = await this.call<ApiMessage>(
      "GET", `/messages/${encodeURIComponent(messageId)}`, { format: "full" }, undefined, undefined, () => new GmailNotFoundError("message", messageId),
    );
    const header = (name: string): string | undefined =>
      m.payload?.headers?.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value;
    const parts: GmailMessagePart[] = [];
    const attachments: GmailAttachmentMeta[] = [];
    const walk = (p: ApiPart | undefined): void => {
      if (!p) return;
      if (p.filename && p.body?.attachmentId) {
        attachments.push({ attachmentId: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType ?? "application/octet-stream", sizeBytes: p.body.size ?? 0 });
      } else if ((p.mimeType === "text/plain" || p.mimeType === "text/html") && p.body?.data) {
        parts.push({ mimeType: p.mimeType, body: b64urlDecode(p.body.data) });
      }
      for (const c of p.parts ?? []) walk(c);
    };
    walk(m.payload);
    const dateHeader = header("Date");
    const parsed = dateHeader ? Date.parse(dateHeader) : NaN;
    return {
      id: m.id ?? messageId,
      threadId: m.threadId ?? "",
      labelIds: m.labelIds ?? [],
      headers: {
        from: header("From") ?? "",
        to: header("To") ?? "",
        subject: header("Subject") ?? "",
        date: m.internalDate ? isoOf(m.internalDate) : Number.isNaN(parsed) ? new Date(0).toISOString() : new Date(parsed).toISOString(),
        ...(header("Cc") ? { cc: header("Cc") } : {}),
        ...(header("In-Reply-To") ? { inReplyTo: header("In-Reply-To") } : {}),
        ...(header("References") ? { references: header("References") } : {}),
      },
      parts,
      attachments,
    };
  }

  async listLabels(): Promise<GmailLabel[]> {
    const r = await this.call<{ labels?: Array<{ id?: string; name?: string; type?: string }> }>("GET", "/labels");
    return (r.labels ?? []).map((l) => ({ id: l.id ?? "", name: l.name ?? "", type: l.type === "user" ? ("user" as const) : ("system" as const) }));
  }

  // ── send ────────────────────────────────────────────────────────────────────────────────────
  async sendMessage(input: GmailSendRequest): Promise<GmailSendResult> {
    const req = validateSendRequest(input);
    let parent: { messageIdHeader: string; references: string } | undefined;
    if (req.inReplyTo) {
      const answered = req.inReplyTo;
      const p = await this.call<ApiMessage>(
        "GET", `/messages/${encodeURIComponent(answered.messageId)}`,
        { format: "metadata", metadataHeaders: ["Message-ID", "References"] }, undefined, undefined,
        () => new GmailNotFoundError("message", answered.messageId),
      );
      if (p.threadId !== answered.threadId) throw new GmailInvalidMessageError("inReplyTo", "the message being answered is not in that thread");
      const h = (name: string) => p.payload?.headers?.find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "";
      const messageIdHeader = h("Message-ID").trim();
      const references = h("References").trim();
      if (!messageIdHeader || CONTROL.test(messageIdHeader) || CONTROL.test(references)) {
        throw new GmailInvalidMessageError("inReplyTo", "the message being answered cannot be threaded");
      }
      parent = { messageIdHeader, references };
    }
    const raw = b64urlEncode(Buffer.from(buildRawMessage(req, parent), "utf8"));
    const sent = await this.call<{ id?: string; threadId?: string }>(
      "POST", "/messages/send", {}, { raw, ...(req.inReplyTo ? { threadId: req.inReplyTo.threadId } : {}) },
      () => new GmailInvalidMessageError("to", "Gmail refused the message"),
    );
    if (!sent.id || !sent.threadId) throw new GmailUnavailableError({ cause: "unexpected-send-response" });
    return { messageId: sent.id, threadId: sent.threadId };
  }
}

export function createGmailApiClient(opts: GmailApiClientOptions): GmailClient {
  return new GmailApiClient(opts);
}
