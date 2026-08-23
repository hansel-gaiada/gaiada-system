# Assessment — what it takes to get `render-gateway-go` off `0.0.0`

**Asked for:** scope the render gateway as its own piece of work, since it gates SMM-29/SMM-34 and
Creative's Image Studio. **Answer in one line:** the blocker is not a GPU and not really the code —
it is a **money-posture decision** that contradicts an existing owner decision, and that decision is
cheap to make and expensive to get wrong.

## 1 · What exists today

Nothing. There is no `render-gateway-go` directory. `MODULES.md` carries `0.0.0 · PLANNED`, and the
entry's own words are "design only … **No code.**" The design is `blueprints/creative-design.md` §05,
v1.0 (2026-07-23), and it is detailed and internally consistent — this is a well-specified service that
was never started, not a vague idea.

Adjacent things that DO exist and reduce the work: `creative` is `0.1.0 PROTOTYPED` (grading + asset
persistence, migrations 0031/0032 + `CreativeController` + the platform-ui studio), and on the social
side **the metering seam already ships** — the usage ledger, budget envelopes and stop-loss chain are
live for X and `ai_cloud_text`. A generation path plugs into existing machinery rather than needing new.

## 2 · The "GPU is the constraint" framing is out of date

An earlier note in this program records the GPU as the Creative blocker. The design supersedes it: one
of **four LOCKED owner decisions (2026-07-23)** is *"GPU posture = **serverless/rent-by-second first**
(RunPod serverless + fal.ai, ComfyUI headless), owned box later."*

So **no hardware purchase is required and no GPU needs to exist in the estate.** Neither box has one
(`gda-aicenter` has no GPU; `gda-ai01` explicitly none) and under the locked decision neither needs one.
Anyone planning this from the older framing will scope the wrong thing.

## 3 · What the blocker actually is

**Money, and a posture conflict.** The design names its own defining hazard as *"GPU money burning by
the second"*, and sets fail-closed envelopes of **image $200 / video $300** per cost class, plus a
**~$100–300/mo** commercial-API budget for video (Veo/Kling/Runway via fal/Replicate).

That collides with an existing decision. **OQ-2 put the social module on a deliberate `$0` path** — X
is disabled at deployment level precisely so publishing spends nothing. SMM-34 (generative images) would
introduce the module's first *unavoidably* paid dependency: unlike X, you cannot ship image generation
disabled and still call the feature delivered.

**This is the decision to make first, and it is not mine:** is Creative/SMM allowed a real monthly spend,
and what is the ceiling? Everything else follows from the answer. Building the gateway before deciding
risks a service whose stop-loss envelopes are set to numbers nobody has agreed to fund.

## 4 · Effort, honestly sized

The design says "mirror of `ai-gateway-go`". That service is **26 non-test Go files / ~4,700 lines with
22 test files** — a fair yardstick for the full build. The Creative wave is **27 `CR-*` tickets**, and
the gateway is the centrepiece of them, not the whole of them.

**But SMM-34 does not need the full service.** It needs *image* generation only, and the slice is
markedly smaller than the wave:

| Needed for SMM-34 | Deferrable |
|---|---|
| One backend class — serverless commercial API (fal/Replicate) | Self-hosted headless ComfyUI on a rented box |
| Commercial-clean models only (Qwen-Image / Qwen-Image-Edit / SDXL / Z-Image-Turbo) | The **FLUX quarantine tier** and its paid opt-in entirely |
| Typed `generate` + `edit` jobs | `t2v` / `i2v` / `FLF2V`, RIFE interpolation, video upscale |
| Job queue + idempotent callback + signed per-job I/O URLs | Model-manifest/workflow versioning beyond one pinned workflow |
| **Stop-loss choke point** (non-negotiable) | The $300 video envelope |
| **Structural license wall** (non-negotiable) | — |
| Egress audit | — |

Dropping video removes the largest cost risk *and* the hardest capability. Dropping FLUX removes the
licensing tier. Dropping self-host ComfyUI removes the infra half.

## 5 · The two things that must not be trimmed

1. **The license wall must be structural, not procedural.** The design's requirement is that a
   non-commercial model *can never reach a client deliverable*. That has to be enforced where the job is
   routed, not by convention — the same reasoning that made the social publish gate a choke point rather
   than a checklist. A licensing mistake here is a legal exposure, not a bug.
2. **Stop-loss must be fail-closed at the choke point**, for the reason the design already gives: per-second
   billing means an error loop is a spending loop. Note the local precedent — an empty env var read as
   `0` once produced a busy loop at 46% CPU; the same shape against a rented GPU bills for it.

## 5b · DECIDED (2026-08-23, owner)

**Approved: a ceilinged spend, booked to CREATIVE — not to social.** No ceiling was named, so build to
the design's own image envelope, **$200/mo**, and treat that as the fail-closed cap until told otherwise.

Why the cost-centre split matters rather than being bookkeeping: **OQ-2's `$0` posture for social
survives intact.** Social does not pay — it *requests* renders, exactly as it already calls the AI
gateway without holding provider keys. The custody rule ("only the Gateway holds provider keys") applies
unchanged, with the render gateway as the key-holder for GPU providers. So SMM-34 stops being a reversal
of OQ-2 and becomes a cross-department consumption, which is a shape this estate already has.

**Scope: the image slice only** (§4's left column) — plausibly 4–6 of the 27 `CR-*` tickets. Video stays
out, so SMM-29 (ClipsAI) stays gated and the $300 video envelope is not created. The FLUX quarantine tier
and self-hosted ComfyUI stay out.

**Unchanged by this decision:** the two untrimmables in §5, and §7's caveat that provider pricing and
model licences were not verified and must be checked at build time — the $200 envelope is only meaningful
against real per-second rates.

## 6 · Recommendation

**Do not start the gateway build yet. Get the spend decision first** (§3) — it is one answer and it
determines the envelopes the service is built around.

If the answer is "yes, with a ceiling", then scope **only the image slice** in §4 as its own small wave
(plausibly 4–6 of the 27 `CR-*` tickets) rather than the full service. That unblocks SMM-34 and Creative's
Image Studio together, leaves SMM-29 (ClipsAI video) still gated, and keeps the first paid dependency in
this estate deliberately small and bounded.

If the answer is "no spend", then **SMM-34 and SMM-29 should be dropped from the social department**
rather than carried as permanently-gated rows — which is the honest bookkeeping, and one of the options
already on the table.

## 7 · What I did not verify

Provider pricing and current model licence terms (fal/Replicate/RunPod rates, the Qwen-Image and
Z-Image-Turbo licences, BFL's FLUX terms). Those move, they are the basis of both the envelopes and the
license wall, and they need checking against the vendors at the time of the decision rather than taken
from a design written 2026-07-23.
