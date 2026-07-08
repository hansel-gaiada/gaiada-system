// Core tools (WS2 §6, trial slice). Real company tools front the platform service layer
// once WS1 exists — a tool handler here must NEVER reach into a database directly.
// AI-backed tools wrap the Gateway (spec §6) — no provider keys in the hub.
import { registerTool } from "./registry";
import { gatewayComplete, gatewayMedia } from "./gateway-client";

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

  registerTool({
    name: "media.extract",
    description:
      "Extract text from media via the governed AI Gateway: audio → transcript, image → description + visible text, pdf → text.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        base64: { type: "string", description: "Base64-encoded file bytes" },
        mime: { type: "string", description: "MIME type, e.g. audio/ogg, image/jpeg, application/pdf" },
      },
      required: ["base64", "mime"],
    },
    handler: async (args) => {
      const base64 = String(args.base64 ?? "");
      const mime = String(args.mime ?? "");
      if (!base64 || !mime) throw new Error("base64 and mime required");
      return gatewayMedia(base64, mime);
    },
  });

  // Deliberately verified-only: demonstrates (and tests) the ceiling. No chat surface
  // can reach it until platform-minted verified principals exist.
  registerTool({
    name: "rollup.metrics",
    description: "Cross-company management rollups (verified principals only).",
    minAssurance: "verified",
    inputSchema: { type: "object", properties: {} },
    handler: async () => JSON.stringify({ note: "management rollup placeholder" }),
  });
}
