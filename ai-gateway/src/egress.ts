// Deterministic egress floor (D8.3, P5d). The Gateway is the one door out; this makes that
// literal by wrapping globalThis.fetch with a DEFAULT-DENY host allowlist. Provider SDKs
// (Gemini/Anthropic) and the direct fetches (Ollama/Whisper) all go through fetch under the
// hood, so a single wrapper enforces the floor for every path. Any host not on the allowlist
// throws before a connection is made and is reported to the caller for audit.
import { config } from "./config";

// Fixed provider endpoints, gated on the corresponding key being configured (no key → not
// reachable). Local model/transcription hosts are derived from their configured URLs.
export function allowedHosts(): Set<string> {
  const hosts = new Set<string>();
  const addUrl = (u: string) => {
    try {
      if (u) hosts.add(new URL(u).host);
    } catch {
      /* ignore malformed */
    }
  };
  if (config.geminiApiKey) hosts.add("generativelanguage.googleapis.com");
  if (config.anthropicApiKey) hosts.add("api.anthropic.com");
  addUrl(config.ollamaUrl);
  addUrl(config.whisperUrl);
  for (const h of config.egressAllowlist) hosts.add(h);
  return hosts;
}

function targetHost(input: unknown): string {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string })?.url ?? "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

let original: typeof globalThis.fetch | null = null;

/** Install the floor once. onBlock is called (for audit) with the denied host before throwing. */
export function installEgressFloor(onBlock?: (host: string) => void): void {
  if (original) return;
  original = globalThis.fetch;
  const base = original;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = targetHost(input);
    // Recompute per call so config/tests stay authoritative.
    if (!host || !allowedHosts().has(host)) {
      onBlock?.(host);
      throw new Error(`egress blocked (not on allowlist): ${host || "unresolved-host"}`);
    }
    return base(input, init);
  }) as typeof globalThis.fetch;
}

export function isEgressInstalled(): boolean {
  return original !== null;
}

export function restoreEgressForTest(): void {
  if (original) {
    globalThis.fetch = original;
    original = null;
  }
}
