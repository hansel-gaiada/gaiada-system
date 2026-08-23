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

## 5c · The image slice, mapped to real tickets (2026-08-23)

The 27 `CR-*` tickets already exist with dependencies, seat tiers and acceptance criteria, so this is a
selection from §12, not a new ticket set.

**⚠ Correcting §4's own estimate.** I guessed "4–6 tickets". **It is 9.** I under-counted the
foundation: CR-01–CR-05 are unavoidable before any render can happen, and no amount of scope-trimming
removes them. Worth stating plainly rather than quietly revising — an estimate that halves the real
number is how a wave gets committed to on the wrong basis.

### The spine — 9 tickets

| Ticket | Why it is unavoidable for SMM-34 | Seat | Effort flag |
|---|---|---|---|
| **CR-01** | `0036_module_creative.sql` — RLS retrofit on the already-shipped `creative_assets` + the §04 columns | senior-db | **opus·medium** — retrofitting RLS on a live table |
| **CR-02** | `creative` ModuleContract + Nest module; `CreativeController` moves into it | senior-be | default |
| **CR-03** | Cerbos policies ×5 + derived roles + `lib/rbac.ts` mirror | medior | default |
| **CR-04** | Render Gateway skeleton: scaffold, job envelope, idempotent `POST /jobs`, `GET /jobs/:id` | senior-be | default (mirrors ai-gateway-go) |
| **CR-05** | Config plumbing both sides + `.env.example` + compose slot | junior | default |
| **CR-06** | **Router + metering choke point** — cost-ordered routing, circuit breakers, and the stop-loss chain. This is the money-safety spine | senior-be | **opus·medium** — double-dispatch, stampede, mid-run-failover ban, true-up |
| **CR-12** | **ComfyUI serverless backend** — seeds `gen-qwen / gen-sdxl / gen-zimage / edit-qwen / bgremove-birefnet@1`. **This is the generation capability itself** | senior-integrator | default (QA gate mandatory) |
| **CR-13** | **The two gates** — spend gate + the reuse/license gate. Non-negotiable per §5 | senior-be | **opus·high** — a bypass puts NC pixels in a client deliverable or burns unapproved money |
| **CR-21** | The **SMM seam** — approved-only listing, and the ledger booking `requester_module='social'` exactly once | medior | default |

**Correction to §4's table:** it listed "self-hosted headless ComfyUI" as deferrable, and that is right —
but **CR-12 is ComfyUI on RunPod *serverless*, which is the rent-by-second path and IS in scope.** Those
are two different things and the §4 wording blurred them.

### Deferred, and what each defers
- **CR-00, CR-07, CR-08, CR-10, CR-11** — the upscale/relight path (P1). A different capability.
- **CR-14, CR-15, CR-16** — the human-facing Generate & Edit canvas.
- **CR-17–CR-20, CR-22** — analyze/CLIP search, library v2, imgproxy renditions, rights expiry.
- **CR-23–CR-26** — all video. Keeps SMM-29 gated and the $300 envelope uncreated, as decided.

### Two consequences of trimming that the owner should weigh

1. **CR-13 bundles the FLUX premium tier** with the two gates. The decision defers FLUX, so CR-13 ships
   with its FLUX route unimplemented — the ticket needs splitting, or its acceptance criterion
   "FLUX route unreachable without tier+permission" is satisfied trivially by the route not existing.
   Either is defensible; it should be a stated choice, not discovered in review.
2. **Deferring CR-09 means spending money blind.** CR-09 carries the *Jobs & Usage* tab — the queue and
   the ledger view. Without it there is no surface showing spend against the $200 cap while it accrues.
   The cap is enforced fail-closed in CR-06 either way, so this is not a safety hole; it is an
   operability one. **My recommendation: pull CR-09 in, making it 10.** Watching the first paid pipeline
   in this estate is worth one senior-fe ticket, and "we discovered the cap by hitting it" is a bad first
   experience of a budget you just approved.

Likewise, with CR-14 deferred there is **no hand-drivable UI for generation** — SMM's composer would be
the first surface to exercise it, which is the frontend-first drift this program keeps getting burned by.
CR-09 partly mitigates that by making jobs observable; if it is also cut, the first proof that generation
works is a social post.

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
