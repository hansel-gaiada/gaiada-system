// WS8 Step C — proves the D13 model-trust gates: weight provenance at intake, pinned-digest
// verification, and eval-gated activation. A model is routable only after BOTH gates pass.
import { describe, it, expect } from "vitest";
import { ModelRegistry, ProvenanceError, type ModelEntry } from "./registry";

const safetensors = (over: Partial<ModelEntry> = {}): Omit<ModelEntry, "status" | "provenanceVerified"> => ({
  id: "llama-3.2-3b",
  name: "Llama 3.2 3B",
  version: "1",
  backend: "vllm",
  provenance: { weightFormat: "safetensors", sha256: "abc123", sourceMirror: "huggingface.co" },
  ...over,
});

const passingEval = { suite: "task-triager", provider: "local:llama-3.2-3b", passed: true, score: 0.9 };

describe("WS8 model registry (Step C, D13)", () => {
  it("registers a well-provenanced local model as an unverified candidate", () => {
    const r = new ModelRegistry();
    const e = r.register(safetensors());
    expect(e.status).toBe("candidate");
    expect(e.provenanceVerified).toBe(false); // must verify the digest before serving
  });

  it("refuses a local weight with a non-allow-listed format, missing sha256, or untrusted mirror", () => {
    const r = new ModelRegistry();
    expect(() => r.register(safetensors({ provenance: { weightFormat: "gguf", sha256: "x", sourceMirror: "huggingface.co" } }))).toThrow(/not allow-listed/);
    expect(() => r.register(safetensors({ provenance: { weightFormat: "safetensors", sourceMirror: "huggingface.co" } }))).toThrow(/pinned sha256/);
    expect(() => r.register(safetensors({ provenance: { weightFormat: "safetensors", sha256: "x", sourceMirror: "sketchy.ru" } }))).toThrow(/trusted mirror/);
  });

  it("a LoRA must name a REGISTERED base model", () => {
    const r = new ModelRegistry();
    expect(() =>
      r.register(safetensors({ id: "triager-lora", backend: "lora", provenance: { weightFormat: "safetensors", sha256: "l1", sourceMirror: "huggingface.co" } })),
    ).toThrow(/baseModelId/);
    r.register(safetensors()); // register the base
    const lora = r.register(safetensors({ id: "triager-lora", backend: "lora", provenance: { weightFormat: "safetensors", sha256: "l1", sourceMirror: "huggingface.co", baseModelId: "llama-3.2-3b" } }));
    expect(lora.status).toBe("candidate");
  });

  it("a cloud model needs no weight blob and is provenance-verified on registration", () => {
    const r = new ModelRegistry();
    const e = r.register({ id: "claude", name: "Claude", version: "4.8", backend: "cloud", provenance: { weightFormat: "none" } });
    expect(e.provenanceVerified).toBe(true);
  });

  it("verifyWeightDigest refuses a mismatch and accepts the pinned digest", () => {
    const r = new ModelRegistry();
    r.register(safetensors());
    expect(() => r.verifyWeightDigest("llama-3.2-3b", "WRONG")).toThrow(ProvenanceError);
    expect(r.verifyWeightDigest("llama-3.2-3b", "abc123").provenanceVerified).toBe(true);
  });

  it("cannot approve without BOTH verified provenance AND a passing eval; routable only once approved", () => {
    const r = new ModelRegistry();
    r.register(safetensors());
    // no verification yet:
    expect(() => r.approveForServing("llama-3.2-3b")).toThrow(/provenance not verified/);
    r.verifyWeightDigest("llama-3.2-3b", "abc123");
    // verified but no eval:
    expect(() => r.approveForServing("llama-3.2-3b")).toThrow(/no passing eval/);
    r.attachEval("llama-3.2-3b", { ...passingEval, passed: false });
    expect(() => r.approveForServing("llama-3.2-3b")).toThrow(/no passing eval/);
    // verified + passing eval:
    r.attachEval("llama-3.2-3b", passingEval);
    expect(r.isRoutable("llama-3.2-3b")).toBe(false); // not approved yet
    expect(r.approveForServing("llama-3.2-3b").status).toBe("approved");
    expect(r.isRoutable("llama-3.2-3b")).toBe(true);
  });

  it("enforces the eval-score floor when the policy sets one", () => {
    const r = new ModelRegistry({ allowedWeightFormats: ["safetensors"], trustedMirrors: ["huggingface.co"], minEvalScore: 0.8 });
    r.register(safetensors());
    r.verifyWeightDigest("llama-3.2-3b", "abc123");
    r.attachEval("llama-3.2-3b", { ...passingEval, score: 0.7 });
    expect(() => r.approveForServing("llama-3.2-3b")).toThrow(/below floor/);
  });
});
