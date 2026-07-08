// Provider adapters. Each throws on failure so the chain can fail over. Keys are read
// from config in THIS service only (D8). `available()` = configured, not health — health
// is the circuit breaker's job.
import { GoogleGenerativeAI } from "@google/generative-ai";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";

export interface Provider {
  name: string;
  available(): boolean;
  complete(prompt: string): Promise<string>;
  media(base64: string, mime: string): Promise<string>;
  embed(text: string): Promise<number[]>;
}

/** Instruction per media class: audio → transcript, image → description, pdf → extraction. */
export function mediaInstruction(mime: string): string {
  if (mime.startsWith("audio/")) return "Transcribe this audio verbatim. Output only the transcript.";
  if (mime.startsWith("image/"))
    return "Describe this image for a work-group digest: what it shows, and transcribe any visible text (signs, documents, screens). Be factual and brief.";
  if (mime === "application/pdf") return "Extract the text content of this document. Output only the text.";
  if (mime.startsWith("video/")) return "Describe what happens in this video and transcribe any speech.";
  return "Describe the content of this file for a work-group digest.";
}

class GeminiProvider implements Provider {
  name = "gemini";
  private model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]> | null = null;

  available(): boolean {
    return config.geminiApiKey.length > 0;
  }

  private getModel() {
    if (!this.model) {
      this.model = new GoogleGenerativeAI(config.geminiApiKey).getGenerativeModel({ model: config.geminiModel });
    }
    return this.model;
  }

  async complete(prompt: string): Promise<string> {
    const r = await this.getModel().generateContent(prompt);
    return r.response.text().trim();
  }

  async media(base64: string, mime: string): Promise<string> {
    const r = await this.getModel().generateContent([
      { inlineData: { data: base64, mimeType: mime } },
      { text: mediaInstruction(mime) },
    ]);
    return r.response.text().trim();
  }

  async embed(text: string): Promise<number[]> {
    const model = new GoogleGenerativeAI(config.geminiApiKey).getGenerativeModel({ model: "text-embedding-004" });
    const r = await model.embedContent(text);
    return r.embedding.values;
  }
}

class ClaudeProvider implements Provider {
  name = "claude";
  private client: Anthropic | null = null;

  available(): boolean {
    return config.anthropicApiKey.length > 0;
  }

  private getClient(): Anthropic {
    if (!this.client) this.client = new Anthropic({ apiKey: config.anthropicApiKey });
    return this.client;
  }

  async complete(prompt: string): Promise<string> {
    const r = await this.getClient().messages.create({
      model: config.anthropicModel,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    const block = r.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text.trim() : "";
  }

  async media(base64: string, mime: string): Promise<string> {
    if (!mime.startsWith("image/") && mime !== "application/pdf") {
      throw new Error(`claude: unsupported media type ${mime}`);
    }
    const content =
      mime === "application/pdf"
        ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } } as const)
        : ({
            type: "image",
            source: { type: "base64", media_type: mime as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: base64 },
          } as const);
    const r = await this.getClient().messages.create({
      model: config.anthropicModel,
      max_tokens: 1024,
      messages: [{ role: "user", content: [content, { type: "text", text: mediaInstruction(mime) }] }],
    });
    const block = r.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text.trim() : "";
  }

  async embed(_text: string): Promise<number[]> {
    throw new Error("claude: embeddings not supported — failing over");
  }
}

/** Local model via Ollama (WS3 topology: LOCAL-FIRST; cloud only as failover). Fully
 *  offline dev/trial: `ollama pull llama3.2` and set LLM_CHAIN=ollama,gemini. Text-only —
 *  media falls through the chain to a multimodal provider. */
class OllamaProvider implements Provider {
  name = "ollama";

  available(): boolean {
    return config.ollamaUrl.length > 0;
  }

  async complete(prompt: string): Promise<string> {
    const res = await fetch(`${config.ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.ollamaModel, prompt, stream: false }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = (await res.json()) as { response?: string };
    if (typeof data.response !== "string") throw new Error("ollama returned no response");
    return data.response.trim();
  }

  async media(_base64: string, mime: string): Promise<string> {
    throw new Error(`ollama: media ${mime} not supported — failing over`);
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${config.ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.ollamaEmbedModel, prompt: text }),
    });
    if (!res.ok) throw new Error(`ollama embed ${res.status}`);
    const data = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(data.embedding)) throw new Error("ollama returned no embedding");
    return data.embedding;
  }
}

/** Self-hosted faster-whisper (5a.3): LOCAL-FIRST transcription for audio. Speaks the
 *  OpenAI-compatible /v1/audio/transcriptions contract (faster-whisper-server, speaches).
 *  Audio-only — everything else throws so the chain falls over to a multimodal provider. */
class WhisperProvider implements Provider {
  name = "whisper";

  available(): boolean {
    return config.whisperUrl.length > 0;
  }

  async complete(_prompt: string): Promise<string> {
    throw new Error("whisper: text completion not supported — failing over");
  }

  async media(base64: string, mime: string): Promise<string> {
    if (!mime.startsWith("audio/")) throw new Error(`whisper: ${mime} not supported — failing over`);
    const form = new FormData();
    const ext = mime.split("/")[1]?.split(";")[0] ?? "ogg";
    form.append("file", new Blob([Buffer.from(base64, "base64")], { type: mime }), `audio.${ext}`);
    form.append("model", config.whisperModel);
    form.append("response_format", "json");
    const res = await fetch(`${config.whisperUrl}/v1/audio/transcriptions`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`whisper ${res.status}`);
    const data = (await res.json()) as { text?: string };
    if (typeof data.text !== "string") throw new Error("whisper returned no text");
    return data.text.trim();
  }

  async embed(_text: string): Promise<number[]> {
    throw new Error("whisper: embeddings not supported — failing over");
  }
}

/** Dev fallback when no provider key is configured — plumbing works, answers are stubs. */
class EchoProvider implements Provider {
  name = "echo";
  available(): boolean {
    return true;
  }
  async complete(prompt: string): Promise<string> {
    return `[echo — no provider key configured] ${prompt.slice(0, 200)}`;
  }
  async media(_base64: string, mime: string): Promise<string> {
    return `[media ${mime} — no provider key configured]`;
  }

  /** Deterministic bag-of-words hash embedding: real cosine geometry, zero providers.
   *  Good enough for offline dev/tests; replaced by ollama/gemini when configured. */
  async embed(text: string): Promise<number[]> {
    const dims = 128;
    const v = new Array<number>(dims).fill(0);
    for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2)) {
      let h = 0;
      for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) >>> 0;
      v[h % dims] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

const registry: Record<string, Provider> = {
  whisper: new WhisperProvider(),
  ollama: new OllamaProvider(),
  gemini: new GeminiProvider(),
  claude: new ClaudeProvider(),
  echo: new EchoProvider(),
};

/** Resolve a configured chain to providers; always terminates with echo so dev mode works. */
export function resolveChain(names: string[]): Provider[] {
  const chain = names.map((n) => registry[n]).filter((p): p is Provider => Boolean(p));
  return [...chain, registry.echo];
}
