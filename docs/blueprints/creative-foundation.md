# Creative Department — Foundation Research

> **Status:** Foundation / research blueprint (no code beyond the already-built Image Studio).
> Feeds a future `creative` module expansion + department console (same pattern as Web Dev /
> WebDesk / SEO-SEM / SMM).
> **Date:** 2026-07-23 · **Author:** Claude (research pass, 4 parallel deep-dives)
> Sources are listed at the end. Convert to a MODULES.md entry when the architect design doc starts.
>
> Sibling blueprints: `seo-sem-foundation.md`, `smm-foundation.md`. Creative is the **asset
> factory** those departments (and Web Dev) consume — read it as the supply side of SMM's
> "digital assets" deliverable.
>
> **📌 DECISIONS (2026-07-23, user) — these gate the architect design doc, now settled:**
> 1. **GPU posture = serverless / rent-by-second first** (RunPod serverless + fal.ai, ComfyUI
>    headless); owned hardware only once steady volume justifies it.
> 2. **Image licensing = hybrid** — commercial-CLEAN default (Qwen/SDXL/Z-Image), **FLUX gated
>    behind an explicit paid opt-in tier** (BFL license or hosted API) for hero deliverables only.
> 3. **Video = hybrid** — Wan 2.2 (OSS) on rented GPU for owned/confidential work **+ a commercial-API
>    budget (~$100–300/mo)** for Veo (synced audio) and hero shots OSS can't match.
> 4. **DAM = build light on our own stack** (not adopt Phrasea).

The goal of this document is to get the **foundation right first**: what the creative team
actually does, what we must deliver, the standard toolchain, where AI genuinely helps, which
open-source bases to adopt, what to build vs buy, **the GPU/hosting reality that governs the whole
thing**, and exactly how it plugs into the gaiada ERP — before any code is written.

> **📌 THE ONE CONSTRAINT THAT SHAPES EVERYTHING (read first):** every capability below —
> upscaling, image generation, image editing, video, image-to-video — is a **heavy GPU diffusion
> workload**. Our only local box is the **Arc iGPU (~12.5 tok/s ceiling, see [[local-inference-setup]])
> — it cannot run *any* of these models.** So the central decision this blueprint resolves is **not
> "which software"** (that answer is boringly consistent: **ComfyUI** orchestrates almost all of it).
> It is **where the GPU lives** — and the answer differs per capability:
> - **Upscaling / image edit** = cheap (seconds, 8–24 GB) → self-host or rent-by-second easily.
> - **Video** = brutal (minutes/clip, 24–80 GB) → rent-by-second or commercial API; **do not buy an
>   80 GB box on day one.**
>
> The clean architectural move is a **Creative Render Gateway** — a job-queue abstraction (mirror of
> `ai-gateway-go`) that routes each render job to the cheapest capable target: **serverless GPU
> (RunPod/fal) · self-hosted ComfyUI · commercial API** — per capability, cost, and license. See §7.

---

## 1. What the Creative department actually does

Four capabilities were named; they are distinct workloads with very different cost/GPU profiles and
licensing traps. Model them as separate **service lines**, not one "creative" bucket.

| Capability | What it is | GPU weight | Marginal cost | License risk |
|---|---|---|---|---|
| **1. Image enhancement / upscaling** (today = Magnific) | Creative upscale that *hallucinates* plausible detail; relight; style/structure transfer | Light–medium (8–24 GB, seconds) | ~$0.02/image OSS | Medium — best model (SUPIR) is non-commercial |
| **2. Image generation + editor** | Text→image, and instruction/canvas editing (object/bg/style/text swap, inpaint/outpaint) | Medium (8–24 GB, seconds) | ~$0.02–0.06/image | **High** — FLUX dev-class weights are non-commercial |
| **3. Video generation + editor** | Text→video + assemble/interpolate/upscale into deliverables | **Heavy (24–80 GB, minutes/clip)** | ~$0.03–0.50/clip | Medium — Hunyuan/SVD carve-outs |
| **4. Image-to-video + editor** | Animate a still; first-frame & first+last-frame morph | **Heavy (24–48 GB, minutes/clip)** | ~$0.03–0.50/clip | Low if Wan-based |
| **(5. Asset management)** | Shared library the *other* departments consume | None (it's data, not GPU) | storage only | None |

Capability 5 (DAM) is the connective tissue: it is **not a GPU problem, it's a data/domain problem**,
and it is the reason Creative exists as shared infrastructure — the assets 1–4 produce are consumed
by SMM (posts), SEO (content imagery), and Web Dev (site media). See §6.

---

## 2. What they *do* — day-to-day deliverables

| Deliverable | What it is | Consumer |
|---|---|---|
| **Upscaled / enhanced imagery** | Client photos, product shots, hero images pushed to print/retina quality | Web Dev, client |
| **Relight / retouch** | Change lighting/mood on product & portrait shots | SMM, client |
| **Generated concept imagery** | On-brand originals, variations, moodboards, ad creative | SMM, SEO, pitches |
| **Edited imagery** | Background swap, object add/remove, text-in-image, format/crop variants | SMM (per-network crops), Web Dev |
| **Short-form video / b-roll** | AI clips, animated stills, motion graphics filler | SMM (Reels/Shorts), ads |
| **Animated stills (I2V)** | Bring a product photo / logo to life; A→B keyframe morphs | SMM, presentations |
| **Brand kits** | Curated logo/palette/font/approved-imagery sets per client | All departments |
| **The asset library itself** | Searchable, rights-cleared, reusable media catalog | **All departments** |

> **The existing [[creative-image-studio]] fits here as the deterministic finishing layer** —
> client-side auto-correct + hand-LUT color grading. The AI ops below sit *underneath* the same
> canvas; the 3D-LUT AI seam already flagged is the natural attach point for learned relight/grade.

---

## 3. Expected client benefit & outcome

Clients pay for **volume, speed, and on-brand consistency of creative** they can't produce in-house —
and increasingly for the *look* premium AI tools give (the "Magnific glow" on upscales, cinematic
AI b-roll). What we're accountable for:

- **Quality parity** with the paid tools they'd otherwise buy (Magnific, Runway, Midjourney).
- **Turnaround** — hours not days, at batch scale.
- **Brand fidelity** — outputs that match the client's kit, not generic AI slop.
- **Rights safety** — every delivered asset is license-clean and usage-cleared (the neglected one
  that creates real legal exposure — see §6 rights tracking).

> **The strategic win:** Creative is the one department where owning the AI stack **directly deletes
> a recurring bill** (Magnific $39–299/mo, plus Midjourney/Runway/etc. per seat). Every capability
> below has a credible OSS path that ends a subscription — *if* we solve the GPU-hosting question.

---

## 4. Industry-standard tools (what the pros use — and what we replace)

| Capability | Pro tools (what clients/competitors pay for) | Our OSS replacement (see §5) |
|---|---|---|
| Creative upscale | **Magnific** (current), Krea, Topaz, Freepik | clarity-upscaler / ComfyUI Tile pipeline |
| Image generation | Midjourney, DALL·E, Adobe Firefly, Ideogram | Qwen-Image / SDXL / Z-Image (+ FLUX if licensed) |
| Image editing | Photoshop (+ Generative Fill), Canva | ComfyUI/InvokeAI + Qwen-Image-Edit |
| Video generation | Runway, Kling, Pika, Luma, **Veo 3** | Wan 2.2 / LTX (+ commercial API for hero/audio) |
| Video editing | Premiere, DaVinci, CapCut | ffmpeg/MoviePy/Remotion + Kdenlive + RIFE/Real-ESRGAN |
| Asset management | **Bynder, Brandfolder** ($25–40k+/yr), Air, Frame.io | Build-light on our stack (§6) |

---

## 5. Where AI helps — the OSS stack, by capability

> **Universal engine: [ComfyUI](https://github.com/comfyanonymous/ComfyUI) (GPL-3.0).** Every model
> below runs in it; new models land there first (Wan 2.2 had same-week support). **Run it as a
> separate headless backend process** we call over its HTTP/WS API (submit workflow JSON to
> `/prompt`, poll `/history`) — GPL copyleft never touches our proprietary code, exactly the
> arm's-length pattern we use for other engines. **InvokeAI (Apache-2.0)** is the exception worth
> embedding directly — it has a real layered-canvas editor and a clean license.

### 5.1 Image enhancement / upscaling (the Magnific replacement)

**What Magnific actually is:** an SDXL diffusion pipeline that *hallucinates* new plausible detail
while a **ControlNet-Tile** structural anchor holds the composition, driven by creativity/HDR
sliders. Not a fidelity upscaler — a *generative* one. That recipe is fully reproducible.

| Piece | Repo | License | Commercial | Verdict |
|---|---|---|---|---|
| **Best drop-in match** | [`philz1337x/clarity-upscaler`](https://github.com/philz1337x/clarity-upscaler) | **AGPL-3.0** | ✅ internal use fine | Purpose-built open "Magnific alternative," powers ClarityAI.co. **On Replicate ~$0.019/run.** |
| DIY equivalent | ControlNet **Tile** + [Ultimate SD Upscale](https://github.com/ssitu/ComfyUI_UltimateSDUpscale) | permissive | ✅ | The core mechanism, most tunable, runs 8–12 GB |
| SOTA restoration | [`Fanghua-Yu/SUPIR`](https://github.com/Fanghua-Yu/SUPIR) | **⚠️ Non-commercial** | ❌ | Often beats Magnific but **license blocks client work** — internal experiments only |
| Clean restoration | [DiffBIR](https://github.com/XPixelGroup/DiffBIR), [SeeSR](https://github.com/cswry/SeeSR) | **Apache-2.0** | ✅ | Commercial-clean; DiffBIR runs on 8 GB |
| Fast/faithful ("Precision" mode) | [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) | BSD | ✅ | Not creative; great fast pre/post pass |
| **Relight** | [IC-Light](https://github.com/lllyasviel/IC-Light) | **V1 ✅ / V2 ⚠️ NC** | use **V1** | Magnific's Relight equivalent |
| Style transfer | IP-Adapter | permissive | ✅ | Magnific's Style Reference |
| Structure | ControlNet (Tile/Depth) | Apache/OpenRAIL | ✅ | Magnific's Structure Reference |

> **Feature → OSS map:** Creative Upscale → clarity-upscaler / Tile+Ultimate SD Upscale · sliders →
> denoise strength + ControlNet weight · Relight → IC-Light **V1** · Style → IP-Adapter · Structure
> → ControlNet · Precision → Real-ESRGAN/DiffBIR. **⚠️ Avoid SUPIR + IC-Light V2 for client work.**

#### Magnific head-to-head (quality · quantity · price · the seat economics)

Apples-to-apples on Magnific's home turf (creative upscale/enhance — our stack *also* does gen/edit/
video/DAM, not credited here).

- **Quality — parity for client work.** clarity-upscaler is literally the open engine powering
  ClarityAI.co (same SDXL + ControlNet-Tile recipe, same "hallucinated detail" glow). SUPIR would
  *exceed* Magnific but is non-commercial → off-limits, so on the clean stack we **match, not beat**.
  Magnific keeps a "turnkey polish" edge until we tune presets — parity here is *earned*, not automatic.
- **Quantity — uncapped vs credit-capped.** Magnific: Pro ~500/mo, Premium ~1,500, Business ~5,000
  credits. Ours: limited only by GPU budget/throughput. The **same $39 buys ~500 Magnific upscales vs
  ~2,000 on Replicate**; on an owned box it's unlimited at ~$0 marginal.
- **Price + the seat point (the whole game).** Magnific bills **per account/seat with a credit cap**.
  Our stack is a **backend service the whole team hits via the platform (MCP-mediated)** — cost is
  **decoupled from headcount**. Not "one seat for all" → **zero seats, one backend; billing is
  compute, not people.**

| Team of 5, ~2,000 upscales/mo | Monthly | Scales with team size? |
|---|---|---|
| **Magnific** — shared 1 Business acct | ~$299 (concurrency-limited, ToS-gray) | — |
| **Magnific** — proper per-seat (5× Premium) | ~$495 | **Yes — +$99 per new person** |
| **Ours — serverless** (Replicate/fal — chosen posture) | **~$38 compute, unlimited seats** | **No — flat** |
| **Ours — owned/rented 24 GB box** | **~$248 flat, unlimited volume + seats** | **No** |

> Unit cost: **~$0.05–0.20/image (Magnific credits) vs ~$0.019 (Replicate) vs ~$0 marginal (owned
> box)** — **3–10× cheaper per image**, and the gap widens with every added person or batch. **The win
> isn't quality (that's parity) — it's cost decoupled from headcount + volume, delivered through MCP.**
>
> **Honest caveats:** (1) Magnific is zero-effort; ours needs the Render Gateway built + light GPU ops.
> (2) *This week* clarity-upscaler on Replicate already saves ~10×/image, but the polished "zero-seat via
> MCP" state arrives only once the Gateway + console ship. (3) Preset tuning is the work that buys parity.
> Break-even (even counting build) arrives fast past ~2–3 people or a few hundred images/mo — and unlike
> Magnific, **the bill stops growing with the team.**

### 5.2 Image generation + editor

**Default pipeline must be 100% commercial-license-clean.** FLUX is the quality ceiling but its
best open weights (dev / Kontext / Krea / FLUX.2 dev) are **non-commercial** — quarantine behind a
paid license gate.

| Model | License | Commercial | VRAM | Role |
|---|---|---|---|---|
| **Qwen-Image** | **Apache-2.0** | ✅ | 16 GB FP8 / ~14 GB Q4 | Cleanest high-quality base; best text rendering |
| **SDXL** | OpenRAIL, no rev cap | ✅ | 8–12 GB | Workhorse; deepest ControlNet/IP-Adapter/LoRA ecosystem |
| **Z-Image-Turbo** | **Apache-2.0** | ✅ | 8–16 GB | Fast (2–3s/img on 4090), photoreal, cheap |
| FLUX schnell / FLUX.2 klein-4B | **Apache-2.0** | ✅ | 8–24 GB | Fast, license-clean (quality below dev) |
| **FLUX.1 Kontext / Krea / FLUX.2 dev** | **⚠️ FLUX NC** | ❌ w/o license | 24 GB+ | **Quality ceiling — needs BFL commercial license or hosted BFL API** |
| **Qwen-Image-Edit** | **Apache-2.0** | ✅ | 16 GB FP8 | **Default instruction-editing engine** (object/bg/style/text/relight) |
| OmniGen 2 | Apache (verify) | ✅ | mid | Unified gen+edit in one model — worth a prototype |

**Editing primitives:** **BiRefNet (MIT)** for background removal — **NOT RMBG** (non-commercial);
inpaint/outpaint via ControlNet + IP-Adapter; IC-Light V1 relight; Real-ESRGAN upscale.

**Editor front-end options:** (a) embed **InvokeAI**'s canvas (Apache-2.0, real layers) directly; or
(b) build our own canvas on **miniPaint / Filerobot (MIT)** over the ComfyUI API, folding in the
existing Image Studio grading. Option (b) matches our "own the UI, engine behind BFF" pattern.

> **FLUX licensing (the biggest trap for a paying agency):** all FLUX *dev*-class weights are
> non-commercial. For client work either (a) buy **BFL's self-serve commercial license** (their
> "Professional/agency" tier covers up to ~3 clients, then per-client fees — quote-gated), or (b)
> call the **hosted BFL/fal/Replicate API** where the license is bundled in the price. **Never ship
> FLUX dev output to a paying client on the free weights.**

### 5.3 & 5.4 Video generation + image-to-video (+ editor)

**Honest framing: video is 10–50× heavier than image.** A 5s 720p clip = minutes of GPU on a 24 GB+
card; best quality wants 40–80 GB. Standardize on **Apache/MIT models** for anything client-facing.

| Model | T2V | I2V | License | Commercial | VRAM | Role |
|---|---|---|---|---|---|---|
| **Wan 2.2** (Alibaba) | ✅ | ✅ **+ first+last-frame** | **Apache-2.0** | ✅ cleanest | 8 GB (5B) → 24–48 GB (14B) | **Anchor.** Best quality + only caveat-free license + native I2V/FLF2V |
| **LTX-Video 13B** | ✅ | ✅ | ⚠️ custom (verify) | ⚠️ | 16–24 GB | **Speed/iteration workhorse** (~1–2 min/clip on 4090) |
| CogVideoX-5B-I2V | ✅ | ✅ dedicated | 5B commercial w/ attribution; 2B Apache | ✅ | 16–36 GB | I2V fallback; mature LoRA ecosystem |
| Mochi-1 | ✅ | ❌ | Apache-2.0 | ✅ | 24–60 GB | Strong T2V motion, no I2V |
| **HunyuanVideo 1.5** | ✅ | ✅ +V2V | ⚠️ Tencent (EU/UK/S.Korea **excluded**, 100M-MAU cap) | ⚠️ | 14–40 GB | Best motion/physics — **only if not serving excluded markets** |
| Stable Video Diffusion | ❌ | ✅ | **⚠️ Non-commercial** | ❌ | 16–24 GB | **Exclude** — dated + NC |

**Image-to-video (named requirement):** **Wan 2.2 I2V + FLF2V** (`WanFirstLastFrameToVideo` node) is
the strongest open option — first-frame *and* first+last-frame ("morph A→B") conditioning are
first-class. CogVideoX-5B-I2V as the fallback where its look fits.

**Video "editing" = a pipeline, not a generative NLE** (no OSS equivalent of a timeline-aware
generative editor exists): generate clips → **RIFE** frame-interpolation → **Real-ESRGAN** upscale
(Topaz Video AI, paid, only for final masters) → assemble with **ffmpeg / MoviePy / Remotion**
(programmatic, pipeline-friendly) or **Kdenlive** (human finishing). Object removal in video (ProPainter
/ Wan V2V + masking) is immature — manage expectations.

**Commercial API fallback (keep a budget):** OSS can't yet match **Veo 3.1's native synced audio** or
top prompt adherence. Keep ~$100–300/mo for **Veo (audio/hero shots)** and **Kling/Runway** via
fal.ai/Replicate. (Sora 2 is sunsetting — do not build on it.)

---

## 6. Asset management (DAM) — BUILD light, don't adopt

**Verdict: build a light DAM domain layer on our existing stack; adopt only the rendition engine
(imgproxy) and the AI models — not a full OSS DAM product.** We already own the three hardest pieces:
**per-tenant RLS file store, the Shared Drive (WS11) service-account, and pgvector.** Every full OSS
DAM (Pimcore, ResourceSpace, Phraseanet) is a *single-org* PHP service with its own auth/storage/
tenancy — adopting one means retrofitting multi-tenancy and running a second search + second
permission model against Cerbos/RLS. The DAM-specific value is a **bounded domain layer**, not
infrastructure.

**What to build:**
- **`asset` domain in platform-nest** — original + version stack, RLS-scoped, blob-backed by the
  existing file store (Drive as archival/shared tier). Reuse the attachment plumbing + `file` Cerbos policy.
- **Metadata / taxonomy / tags** — per-tenant custom schema (reuse D17 custom-fields), controlled
  vocab, EXIF/XMP auto-populate at ingest.
- **Collections + brand kits** — many-to-many; a brand kit = typed collection (logo/palette/font slots).
- **Rights / licensing gate** — license type, model/property releases, territory, expiry; warn at
  share/download; **approved-status gates cross-dept visibility** (reuse the **WS4 approvals surface**
  for "approve for reuse").
- **Renditions = [imgproxy](https://github.com/imgproxy/imgproxy) sidecar (MIT, Go/libvips)** —
  stateless, signed URLs, on-the-fly thumbnails/WebP-AVIF/social crops. Add **thumbor** later only
  for smart-crop face detection.
- **AI at ingest (async, fail-soft):** **CLIP embedding → pgvector** (semantic + visual "find
  similar" search + dedup); **BLIP caption + object tags** → searchable metadata. This is the marquee
  feature and we already run the vector DB.
- **Cross-dept BFF contract** — `/api/:t/dam/assets`, `/collections`, `/search` (keyword +
  `?similar_to=` vector); stable rendition URLs SMM/SEO/Web Dev embed. Same frontend-first-contract
  pattern as the rest of the platform.

**Adopt-only-if:** leadership wants out-of-box cataloging governance/brand portals we can't build →
the sole candidate is **[Phrasea](https://github.com/alchemy-fr/phrasea)** (MIT, modern microservices,
AI seams), wrapped behind our BFF as an internal engine. Given our stack, that's a heavier lift than
building — build remains the recommendation.

---

## 7. The GPU / hosting decision (the spine)

Three targets; the right one differs per capability. **Start rent-by-second, own hardware only at
sustained volume.**

| Target | Cost signal (2026) | Best for |
|---|---|---|
| **Serverless GPU** (RunPod serverless, fal.ai) | Image ~$0.02–0.06/img; Wan video ~$0.05/sec; RunPod 4090 $0.34/hr, A100 $1.39/hr, H100 ~$2.89/hr, billed/sec | **Default.** Spiky agency load, scale-to-zero, no idle burn |
| **Rented dedicated GPU box** (RunPod/Vast monthly) | 4090 ≈ $248/mo, A100 ≈ $1,015/mo | Steady daily work; run ComfyUI headless, own the pipeline |
| **Commercial API** (Replicate/fal/BFL/Veo/Kling) | per-call, license bundled | FLUX-quality without the NC-weight headache; Veo audio; hero video shots |
| **Owned hardware** (24 GB 4090 → 48–80 GB) | capex; economical only at high steady volume | Later — data-residency + break-even justify it |

**Per-capability guidance:**
- **Upscale / image / edit:** cheap. A single **24 GB GPU (owned or rented)** runs the *entire*
  Magnific-equivalent + Qwen/SDXL/Z-Image + editing stack. Break-even vs Magnific+Midjourney seats
  arrives fast.
- **Video:** rent-by-second (RunPod/fal ComfyUI) + commercial-API budget. **Raw compute is cheap
  (~$0.03/Wan clip on a $0.34/hr 4090); the real costs are latency, engineering, and GPU
  availability** — not dollars. **Do not buy an 80 GB box first.**

> **Architecture: the Creative Render Gateway.** Mirror `ai-gateway-go` — a **render job-queue**
> that accepts a typed job (upscale/generate/edit/t2v/i2v), routes it to the cheapest capable target
> (serverless / self-host ComfyUI / commercial API) per capability + license + cost cap, enforces
> **WS4 approvals + credit metering** (generative image/video is the highest-cost class), audits
> egress, and drops outputs into the DAM. This keeps tenancy/cost/authz in *our* code and treats GPU
> capacity as a swappable backend — the same discipline that makes the AI Gateway safe.

---

## 8. Integration points to the ERP

| ERP subsystem | Integration |
|---|---|
| **platform-nest** (core) | New/expanded `creative` vertical: `asset` domain (DAM §6), render-job records, service lines (enhance/generate/edit/video), RLS-scoped per company. Extends the existing `creative_assets` tables ([[creative-image-studio]]). |
| **platform-ui** | Creative console on the **[[dept-interface-template]]**: Image Studio (built) + Generate/Edit canvas + Upscale + Video + **Asset Library** (the shared, searchable, rights-gated surface other depts hit). |
| **Creative Render Gateway** (new) | The job-queue/router of §7 — the one new service. Routes to serverless GPU / self-host ComfyUI / commercial API; enforces approvals + credits + audit. |
| **ai-gateway-go** | LLM assist: prompt drafting/expansion, caption/tagging (BLIP), and the `image.enhance`/generative capabilities the MCP Hub already reserved a seam for (see CLAUDE.md — "Magnific `image.enhance`… no Gateway capability yet"). |
| **pgvector RAG (WS8)** | CLIP visual/semantic search + dedup over the asset library; brand-voice/brand-kit RAG for on-brand generation. |
| **approvals surface (WS4)** | **Mandatory** gate on generative output + "approve asset for cross-dept reuse." Generative image/video is the highest-cost + rights-sensitive class. |
| **mcp-hub** | Register a `creative` MCP (generate/edit/upscale/search-assets) so WS8 agents + other depts can *request* creative into the approval/credit queue. Fills the reserved `image.enhance` gap. |
| **automation (n8n, WS4)** | Batch upscale jobs, ingest→auto-tag pipeline, render-then-notify, brand-kit assembly. n8n orchestrates, MCP/Gateway accesses. |
| **Shared Drive (WS11)** | Archival/shared blob tier for produced assets + client deliverables. |
| **SMM / SEO / Web Dev** | **Consumers.** SMM pulls approved assets + per-network crops (imgproxy); SEO pulls content imagery; Web Dev embeds rendition URLs. Creative is their supply side. |
| **observability (WS9)** | Render-job telemetry (cost, latency, GPU target, failure), per-backend health via existing OTel. |
| **event backbone / notifications** | Render done/failed, budget hit, rights-expiry, "new asset approved for reuse" → tasks + alerts. |

---

## 9. Fork / build strategy

Same holding-OS playbook as SEO/SMM — do **not** expose stock external apps.

1. **ComfyUI runs headless behind the Render Gateway** — arm's-length HTTP; GPL never touches our
   code. Workflows stored as versioned JSON per capability.
2. **AuthN/AuthZ** — Keycloak OIDC + Cerbos; no tool-native logins exposed.
3. **AI routing** — LLM assist via `ai-gateway-go`; embeddings via pgvector.
4. **Backend abstraction** — GPU target (serverless / self-host / commercial API) pluggable per
   capability + cost cap, exactly like the Gateway's provider chain.
5. **Approvals + credits** — every generative render routes through WS4 + cost metering.
6. **License discipline (the hard rule):** default pipeline = **Apache/MIT/permissive only** (Qwen,
   SDXL, Z-Image, Wan 2.2, BiRefNet, IC-Light V1, DiffBIR). **Quarantine** the non-commercial set
   (FLUX dev-class, SUPIR, RMBG, IC-Light V2, SVD, HunyuanVideo geo-caveats) behind explicit
   license gates or hosted APIs. Bake license metadata into each render workflow so nothing NC ever
   reaches a client deliverable.
7. **Storage** — assets + versions + renditions in the DAM domain (Postgres + file store + Drive),
   not tool-local DBs.
8. **UI** — surface through the dept-console template, not ComfyUI/InvokeAI's own UIs.
9. **Events** — emit renders/failures/rights-expiry to the outbox backbone.

---

## 10. Recommended next steps

1. **Phase 0 — stop the Magnific bleed this week:** point the team at **clarity-upscaler on
   Replicate (~$0.019/run)** — zero infra, ~10× cheaper per image than Magnific credits. Validates
   the OSS-parity claim before we build anything. *(A ~1-day spike, not a project.)*
2. **DECIDE the pivotal questions (see below)** — GPU hosting posture, FLUX-license appetite,
   commercial-video-API budget. These gate the design doc.
3. **Spike ComfyUI headless** on a rented RunPod 24 GB box: the clarity/Tile upscale workflow +
   Qwen-Image + Qwen-Image-Edit + BiRefNet + IC-Light V1 + a Wan 2.2 I2V clip. Confirm parity + the
   HTTP-API integration shape for the Render Gateway.
4. **Architect design doc** — the `creative` vertical schema (asset/DAM + render jobs), the
   **Creative Render Gateway** contract, the console tabs, and n8n flows. Same path as WebDesk/SEO-SEM.
5. **Legal confirm** — AGPL (clarity-upscaler) internal-use posture; FLUX/BFL commercial-license terms
   if we want the quality ceiling; the license-quarantine list in §9.6.
6. **Register** as expanded `creative` module(s) in `docs/modules/MODULES.md` when the design doc
   lands. Follow [[status-language-and-versioning]] and mobilize via [[agent-army-standard]] / /army.

> **Decisions ✅ SETTLED (2026-07-23, user) — see the DECISIONS block at the top:**
> serverless/rented GPU first · hybrid image licensing (clean default + FLUX paid opt-in) ·
> hybrid video (Wan OSS + Veo/Kling API budget) · build-light DAM on our stack.

---

## Sources

- **Upscaling / Magnific:** [clarity-upscaler](https://github.com/philz1337x/clarity-upscaler) ·
  [SUPIR](https://github.com/Fanghua-Yu/SUPIR) · [DiffBIR](https://github.com/XPixelGroup/DiffBIR) ·
  [SeeSR](https://github.com/cswry/SeeSR) · [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) ·
  [IC-Light](https://github.com/lllyasviel/IC-Light) · [Ultimate SD Upscale](https://github.com/ssitu/ComfyUI_UltimateSDUpscale) ·
  [clarity on Replicate](https://replicate.com/philz1337x/clarity-upscaler) · [Freepik→Magnific rebrand](https://tech.eu/2026/04/28/freepik-rebrands-as-magnific-unifying-its-ai-creative-stack-as-enterprise-and-no-collar-growth-accelerates/)
- **Image gen/edit:** [ComfyUI](https://github.com/comfyanonymous/ComfyUI) · [InvokeAI](https://github.com/invoke-ai/InvokeAI) ·
  [Qwen-Image](https://github.com/QwenLM/Qwen-Image) · [Z-Image](https://github.com/Tongyi-MAI/Z-Image) ·
  [FLUX](https://github.com/black-forest-labs/flux) · [BFL licensing](https://bfl.ai/licensing) ·
  [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) · [miniPaint](https://github.com/viliusle/miniPaint) ·
  [Filerobot](https://github.com/scaleflex/filerobot-image-editor)
- **Video / I2V:** [Wan 2.2](https://github.com/Wan-Video/Wan2.2) ·
  [Wan FLF2V workflow](https://comfy.org/workflows/video_wan2_2_14B_flf2v-7016f027bcf1/) ·
  [LTX-Video](https://github.com/Lightricks/LTX-Video) · [HunyuanVideo 1.5](https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5) ·
  [CogVideoX-I2V](https://replicate.com/thudm/cogvideox-i2v) · [Mochi](https://github.com/genmoai/models) ·
  [RIFE](https://github.com/hzwer/ECCV2022-RIFE) · [HF State of open video gen](https://huggingface.co/blog/video_gen)
- **DAM:** [ResourceSpace](https://www.resourcespace.com/) · [Pimcore](https://github.com/pimcore/pimcore) ·
  [Phrasea](https://github.com/alchemy-fr/phrasea) · [Directus](https://github.com/directus/directus) ·
  [Payload](https://github.com/payloadcms/payload) · [imgproxy](https://github.com/imgproxy/imgproxy) ·
  [thumbor](https://github.com/thumbor/thumbor) · [CLIP+pgvector image search](https://www.tigerdata.com/blog/how-to-build-an-image-search-application-with-openai-clip-postgresql-in-javascript) ·
  [BLIP](https://huggingface.co/Salesforce/blip-image-captioning-base)
- **GPU/hosting:** [RunPod pricing](https://gpuvec.com/providers/runpod) · fal.ai · Replicate

> **Accuracy caveats (re-verify at build time):** star counts and GPU prices shift fast. **License
> flags are the load-bearing facts here** — SUPIR, IC-Light V2, RMBG, SVD are **non-commercial**;
> FLUX dev-class weights need a **paid BFL license**; HunyuanVideo excludes **EU/UK/S.Korea** + has a
> 100M-MAU cap; **LTX-Video's license is genuinely ambiguous** across sources — confirm with
> Lightricks before commercial use. The default stack (Qwen, SDXL, Z-Image, Wan 2.2, BiRefNet,
> IC-Light V1, DiffBIR, imgproxy) is chosen specifically to be commercial-license-clean.
