// Core tools (WS2 §6, trial slice). Real company tools front the platform service layer
// once WS1 exists — a tool handler here must NEVER reach into a database directly.
// AI-backed tools wrap the Gateway (spec §6) — no provider keys in the hub.
import { registerTool } from "./registry";
import { gatewayComplete, gatewayMedia } from "./gateway-client";
import { config } from "./config";

export function registerCoreTools(): void {
  registerTool({
    name: "ping",
    description: "Liveness check.",
    minAssurance: "anonymous",
    inputSchema: { type: "object", properties: {} },
    handler: async () => "pong",
  });

  registerTool({
    name: "whoami",
    description: "The principal the hub minted for you (proves the OBO envelope, not the service, is who you act as).",
    minAssurance: "anonymous",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, principal) => JSON.stringify(principal),
  });

  // AI-backed tools (Gateway-wrapped). `low` minimum: an identified caller (OBO envelope
  // present) may spend Gateway budget; anonymous callers may not.
  registerTool({
    name: "llm.summarize",
    description: "Summarize text into a concise work summary (via the governed AI Gateway).",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The text to summarize" } },
      required: ["text"],
    },
    handler: async (args) => {
      const text = String(args.text ?? "");
      if (!text.trim()) throw new Error("text required");
      return gatewayComplete(`Summarize the following concisely for a work context:\n\n${text}`);
    },
  });

  // Media extraction tools (spec §6). The Gateway routes by MIME internally, so ocr/vision/
  // transcribe share one egress path — the distinct tool names give AI clients a precise verb
  // and a schema hint for the file kind. `media.extract` stays as the general alias.
  const mediaInput = (hint: string) => ({
    type: "object",
    properties: {
      base64: { type: "string", description: "Base64-encoded file bytes" },
      mime: { type: "string", description: hint },
    },
    required: ["base64", "mime"],
  });
  const mediaHandler = async (args: Record<string, unknown>): Promise<string> => {
    const base64 = String(args.base64 ?? "");
    const mime = String(args.mime ?? "");
    if (!base64 || !mime) throw new Error("base64 and mime required");
    return gatewayMedia(base64, mime);
  };

  registerTool({
    name: "media.extract",
    description:
      "Extract text from any media via the governed AI Gateway: audio → transcript, image → description + visible text, pdf → text.",
    minAssurance: "low",
    inputSchema: mediaInput("MIME type, e.g. audio/ogg, image/jpeg, application/pdf"),
    handler: mediaHandler,
  });

  registerTool({
    name: "ocr.extract",
    description: "OCR: extract visible text from an image or PDF via the governed AI Gateway.",
    minAssurance: "low",
    inputSchema: mediaInput("MIME type, e.g. image/jpeg, image/png, application/pdf"),
    handler: mediaHandler,
  });

  registerTool({
    name: "vision.describe",
    description: "Describe an image (scene + any visible text) via the governed AI Gateway.",
    minAssurance: "low",
    inputSchema: mediaInput("Image MIME type, e.g. image/jpeg, image/png"),
    handler: mediaHandler,
  });

  registerTool({
    name: "media.transcribe",
    description: "Transcribe audio to text via the governed AI Gateway.",
    minAssurance: "low",
    inputSchema: mediaInput("Audio MIME type, e.g. audio/ogg, audio/mpeg, audio/wav"),
    handler: mediaHandler,
  });

  // Spec §6 lists image.enhance (Magnific). The Go Gateway exposes no image-enhance capability
  // (only /complete, /media, /embed), so the tool is registered but fails closed with a clear
  // message rather than pretending — it lights up when the Gateway adds the capability.
  registerTool({
    name: "image.enhance",
    description: "Upscale/enhance an image (Magnific) via the governed AI Gateway — NOT YET ENABLED (no Gateway capability).",
    minAssurance: "low",
    inputSchema: mediaInput("Image MIME type, e.g. image/jpeg, image/png"),
    handler: async () => {
      throw new Error("image.enhance is not enabled: the AI Gateway exposes no image-enhance capability yet");
    },
  });

  // Cross-company management rollups (§7). Verified-only (no chat surface can reach it) AND
  // topology-scoped: only the CENTRAL hub serves real rollups, over the platform's D12 cross-
  // company read path (GET /rollups — the single sanctioned cross-company read; the platform
  // re-checks with Cerbos: platform_admin / group_executive). A site hub returns a clear note.
  registerTool({
    name: "rollup.metrics",
    description: "Cross-company management rollups (verified principals; central hub only).",
    minAssurance: "verified",
    inputSchema: {
      type: "object",
      properties: { period: { type: "string", description: "YYYY-MM-DD (defaults to today)" } },
    },
    handler: async (args, principal) => {
      if (config.topology !== "central") {
        return JSON.stringify({ note: "cross-company rollups are served by the central hub only", topology: config.topology });
      }
      const qs = args.period ? `?period=${encodeURIComponent(String(args.period))}` : "";
      const res = await fetch(`${config.platformUrl}/rollups${qs}`, {
        headers: {
          Authorization: `Bearer ${config.platformToken}`,
          "x-obo-provider": principal.provider,
          "x-obo-external-id": principal.externalId,
        },
      });
      if (res.status === 401 || res.status === 403) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "platform denied the request");
      }
      if (!res.ok) throw new Error(`platform /rollups ${res.status}`);
      return JSON.stringify(await res.json());
    },
  });
}
