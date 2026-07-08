// AI client — calls the standalone Gateway over HTTP. The bot holds NO model key.
import { config } from "./config";

export async function complete(prompt: string): Promise<string> {
  try {
    const res = await fetch(`${config.gatewayUrl}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.gatewayToken ? { Authorization: `Bearer ${config.gatewayToken}` } : {}),
      },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return `[Gateway ${res.status}: ${body.slice(0, 120)}]`;
    }
    const data = (await res.json()) as { text?: string };
    return data.text ?? "";
  } catch (err) {
    return `[Gateway unreachable: ${(err as Error).message} — is it running? npm run gateway]`;
  }
}

/** Media → text via the Gateway's multimodal endpoint. Throws on failure so the caller
 *  can mark the media row failed (unlike chat, a placeholder must not be stored as a transcript). */
export async function describeMedia(bytes: Buffer, mime: string): Promise<string> {
  const res = await fetch(`${config.gatewayUrl}/media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.gatewayToken ? { Authorization: `Bearer ${config.gatewayToken}` } : {}),
    },
    body: JSON.stringify({ base64: bytes.toString("base64"), mime }),
  });
  if (!res.ok) throw new Error(`gateway /media ${res.status}`);
  const data = (await res.json()) as { text?: string };
  if (!data.text) throw new Error("gateway /media returned no text");
  return data.text;
}
