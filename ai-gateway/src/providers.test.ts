import { describe, it, expect, vi } from "vitest";
import { resolveChain } from "./providers";
import { Chain } from "./chain";
import { config } from "./config";

describe("local-first provider chain (WS3)", () => {
  it("ollama serves completions locally when available", async () => {
    config.ollamaUrl = "http://ollama.test";
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      expect(url).toBe("http://ollama.test/api/generate");
      expect(JSON.parse(init?.body ?? "{}")).toMatchObject({ model: config.ollamaModel, stream: false });
      return { ok: true, json: async () => ({ response: "local answer" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const chain = new Chain(resolveChain(["ollama"]));
    const { result, provider } = await chain.run((p) => p.complete("hi"));
    vi.unstubAllGlobals();
    expect(provider).toBe("ollama");
    expect(result).toBe("local answer");
  });

  it("ollama down → chain fails over (echo terminator) instead of erroring", async () => {
    config.ollamaUrl = "http://ollama.test";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const chain = new Chain(resolveChain(["ollama"]));
    const { provider } = await chain.run((p) => p.complete("hi"));
    vi.unstubAllGlobals();
    expect(provider).toBe("echo");
  });

  it("whisper transcribes audio locally via the OpenAI-compatible contract (5a.3)", async () => {
    config.whisperUrl = "http://whisper.test";
    const fetchMock = vi.fn(async (url: string, init?: { body?: FormData }) => {
      expect(url).toBe("http://whisper.test/v1/audio/transcriptions");
      const form = init?.body as FormData;
      expect(form.get("model")).toBe(config.whisperModel);
      expect((form.get("file") as Blob).type).toBe("audio/ogg");
      return { ok: true, json: async () => ({ text: "two more welders on site B" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const chain = new Chain(resolveChain(["whisper"]));
    const { result, provider } = await chain.run((p) => p.media("aGk=", "audio/ogg"));
    vi.unstubAllGlobals();
    expect(provider).toBe("whisper");
    expect(result).toBe("two more welders on site B");
  });

  it("whisper handles ONLY audio — images fall through it to the next provider", async () => {
    config.whisperUrl = "http://whisper.test";
    const fetchMock = vi.fn(async (url: string) => {
      // Only gemini-style calls should ever hit the network for an image here.
      expect(url).not.toContain("whisper.test");
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const chain = new Chain(resolveChain(["whisper"]));
    const { provider } = await chain.run((p) => p.media("aGk=", "image/jpeg"));
    vi.unstubAllGlobals();
    expect(provider).toBe("echo"); // fell through whisper without a network call
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("whisper down → audio fails over down the chain instead of erroring", async () => {
    config.whisperUrl = "http://whisper.test";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const chain = new Chain(resolveChain(["whisper"]));
    const { provider } = await chain.run((p) => p.media("aGk=", "audio/ogg"));
    vi.unstubAllGlobals();
    expect(provider).toBe("echo");
  });

  it("media requests skip ollama (text-only) and fail over down the chain", async () => {
    config.ollamaUrl = "http://ollama.test";
    const chain = new Chain(resolveChain(["ollama"]));
    const { provider } = await chain.run((p) => p.media("aGk=", "audio/ogg"));
    expect(provider).toBe("echo");
  });
});
