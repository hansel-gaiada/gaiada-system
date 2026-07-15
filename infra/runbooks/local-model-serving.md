# Runbook — Local model serving + model registry (WS10 infra × WS8 §5)

This is the **infra** side of WS8's model platform. The WS8 governance code (`ai-agents/src/models/
registry.ts`, weight-provenance + eval-gated activation) is built and tested; this runbook is how you
stand up local serving, register a model so it becomes routable, and size hardware. GPU + weight blobs
are not code — they live here.

> **Rule:** a local model is routable only after it clears BOTH gates (WS8 Step C / D13): its **weight
> provenance is verified** (allow-listed format + pinned SHA-256 + trusted mirror) AND it **passes its
> eval suite** (the Step-A harness). Serving a model does not make it approved — the registry does.

## 1. Ollama-first serving (the default local path)

The Go Gateway (`ai-gateway-go`) already routes local-first: `LLM_CHAIN` defaults to
`ollama,gemini,claude` (cloud is failover), `EMBED_CHAIN`/`MEDIA_CHAIN` likewise. Point it at an Ollama:

```bash
# On the VPS/host running models:
ollama serve                      # listens on :11434
ollama pull llama3.2              # or your chosen local model
ollama pull nomic-embed-text      # embeddings (Gateway /embed, knowledge RAG)
```

Compose env on the `ai-gateway` service (`infra/compose/docker-compose.vps.yml`):

```
OLLAMA_URL:        http://host.docker.internal:11434   # or the models host
OLLAMA_MODEL:      llama3.2
OLLAMA_EMBED_MODEL: nomic-embed-text
LLM_CHAIN:         ollama,gemini,claude                # keep echo only for keyless dev
```

With Ollama reachable the whole stack runs offline; cloud keys are optional failover. **`echo` stays
the keyless terminator for dev** — never leave it ahead of a real provider in a deployed chain.

## 2. Registering a model so it becomes routable (WS8 Step C)

Serving ≠ approved. Before an agent (especially a **write-capable** one, D13) may rely on a local
model, register + verify + eval it:

1. **Register** with provenance — safetensors, a **pinned SHA-256**, a **trusted mirror**
   (`DEFAULT_POLICY.trustedMirrors`; widen deliberately). A LoRA/fine-tune must name its registered base.
2. **Verify the digest** — `verifyWeightDigest(id, actualSha256)` against the downloaded blob; a
   mismatch is refused (code-signing does not cover weight blobs).
3. **Eval** — run the agent's eval suite + tool-calling contract against the model (as a provider);
   attach the attestation.
4. **Approve** — `approveForServing(id)` succeeds only with verified provenance + a passing eval ≥ the
   policy score floor. `isRoutable(id)` is then true.

**The one live wire:** have the Gateway consult `isRoutable` before routing to a local model (today the
registry is a library; wire it into the Gateway's provider selection at deploy). Until then, treat the
registry as the operator's approval record and only enable a local model in `LLM_CHAIN` once it's approved.

## 3. D13 failover safety (now enforceable end-to-end)

The Gateway reports the **served provider** in the `/complete` response, and `ai-agents` records it
(`deps.lastProvider`). A write-capable agent (`runWriteAgent`) runs with writes ONLY on a provider in
its `evaledProviders`; on any other it is forced read-only. WS9 (`obs/collector.ts
writesOnUnevaledProvider`) additionally flags, after the fact, any write that ran on an un-evaled
provider — a detective control complementing the preventive gate. Operationally: add a provider to an
agent's `evaledProviders` only after step 2 of §2 for that agent.

## 4. GPU sizing (feeds capacity planning)

Rough VRAM budget (inference, 4-bit quantized unless noted):

| Model class | Params | ~VRAM (Q4) | Serve with |
|---|---|---|---|
| Small (llama3.2, qwen2.5-3b) | 3B | ~3–4 GB | Ollama (CPU ok, slow) |
| Mid (llama3.1-8b, qwen2.5-7b) | 7–8B | ~6–8 GB | Ollama / vLLM, 1× 12–16 GB GPU |
| Large (qwen2.5-32b, llama3.3-70b) | 32–70B | ~24–48 GB | vLLM, 1–2× 24–48 GB GPU |
| Fine-tune / LoRA train | 7–8B | ~24 GB+ | dedicated training GPU (A100/H100 class) |

Guidance: **start on Ollama** (single box, easy). Move to **vLLM** when you need throughput/concurrency
or paged-attention for larger contexts. Only provision GPU once a real workload justifies it — do not
buy ahead of evidence. LoRA/fine-tune runs are batch jobs on a training GPU, not the serving box.

## 5. Fine-tuning / LoRA flow (WS8 §8.4)

1. Assemble the dataset (Gaiada data; respect D9 classification — regulated data stays regulated).
2. Train a LoRA adapter on a training GPU (base model pinned by SHA-256 in the registry).
3. Register the adapter as a `lora` entry naming its `baseModelId`; verify its digest.
4. Eval it against the target agent's suite; `approveForServing` only if it beats the baseline.
5. Enable it in serving (Ollama `Modelfile` adapter / vLLM LoRA) once approved.

Deferred until a training GPU exists: the actual training pipeline + dataset governance tooling.
