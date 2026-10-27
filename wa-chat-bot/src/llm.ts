// AI client — calls the standalone Gateway over HTTP. The bot holds NO model key.
//
// AIP-03b — every call here also reports ONE usage event (usage-reporter.ts, fire and forget, never awaited, never throws) so the platform's
// `ai_usage_events` sees the bot's spend. What the bot knows at the call: its company (`botTenantId`), that no person is attached (a chat sender is
// not a platform user: `userId` is null, always), and the capability. surface is `bot`; task is `bot.complete` / `bot.media`.
import { config } from "./config"; // first: it loads .env before usage-reporter reads PLATFORM_URL
import { usageReporter } from "./usage-reporter";
import { usageEvent } from "./usage-event";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The company the bot's AI calls are recorded against: DEFAULT_TENANT_ID (the bot's default company), else TENANT_ID when that is a uuid
 *  (its default, `trial`, is a store label, not a company). Null when neither is: the reporter then writes nothing and says so once. */
export function botTenantId(): string | null {
  for (const v of [config.defaultTenantId, config.tenantId]) if (UUID_RE.test(v)) return v;
  return null;
}

export async function complete(prompt: string): Promise<string> {
  let status: number | null = null; // null until the gateway answers: unreachable is an `error` row
  let data: { text?: string; provider?: string; usage?: unknown } | null = null;
  try {
    const res = await fetch(`${config.gatewayUrl}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.gatewayToken ? { Authorization: `Bearer ${config.gatewayToken}` } : {}),
      },
      body: JSON.stringify({ prompt }),
    });
    status = res.status;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return `[Gateway ${res.status}: ${body.slice(0, 120)}]`;
    }
    data = (await res.json()) as { text?: string; provider?: string; usage?: unknown };
    return data.text ?? "";
  } catch (err) {
    return `[Gateway unreachable: ${(err as Error).message} — is the ERP gateway (GATEWAY_URL) reachable?]`;
  } finally {
    usageReporter.report(usageEvent({ tenantId: botTenantId(), userId: null, surface: "bot", capability: "llm", task: "bot.complete" }, status, data));
  }
}

/** Media → text via the Gateway's multimodal endpoint. Throws on failure so the caller
 *  can mark the media row failed (unlike chat, a placeholder must not be stored as a transcript). */
export async function describeMedia(bytes: Buffer, mime: string): Promise<string> {
  let status: number | null = null;
  let data: { text?: string; provider?: string; usage?: unknown } | null = null;
  try {
    const res = await fetch(`${config.gatewayUrl}/media`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.gatewayToken ? { Authorization: `Bearer ${config.gatewayToken}` } : {}),
      },
      body: JSON.stringify({ base64: bytes.toString("base64"), mime }),
    });
    status = res.status;
    if (!res.ok) throw new Error(`gateway /media ${res.status}`);
    data = (await res.json()) as { text?: string; provider?: string; usage?: unknown };
    if (!data.text) throw new Error("gateway /media returned no text");
    return data.text;
  } finally {
    usageReporter.report(usageEvent({ tenantId: botTenantId(), userId: null, surface: "bot", capability: "media", task: "bot.media" }, status, data));
  }
}
