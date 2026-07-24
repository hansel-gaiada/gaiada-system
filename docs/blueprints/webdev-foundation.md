# Web Dev Department — Foundation Blueprint

> **Status:** Foundation / direction-setting blueprint. Unlike the SEO / SMM / Creative
> foundations (which were greenfield), Web Dev is the **most-developed department already** —
> this document's job is to draw **one map** over three scattered programs + the webdesk platform,
> weld them into a single department, and sequence what's left. Feeds an architect design doc
> (`webdev-design.md`) and then `/army` tickets, same pattern as the siblings.
> **Date:** 2026-07-24 · **Owner conversation:** hansel@gaiada.com
>
> Sibling blueprints: `seo-sem-foundation.md`, `smm-foundation.md`, `creative-foundation.md`.
> Creative is the **asset supply side** this department consumes (site media, design assets).
>
> **📌 DECISIONS (2026-07-24, user) — these gate the architect design doc:**
> 1. **Scope = productivity + webdesk unified.** One foundation covering both the web-dev *team's*
>    daily productivity tools AND the **webdesk** client-site platform, sequenced together — not
>    three separate programs.
> 2. **Capture entry = both, manual first.** Ship the in-ERP record/upload → audio→PRD path first
>    (wire the existing `capture-helper` Whisper edge into the dispatcher); design the auto-join
>    meeting-bot as a phase-2 seam.
> 3. **Build↔webdesk coupling = one rail.** The delivery pipeline's `code.scaffold` generates
>    frontends **against the webdesk codegen'd contract** (typed SDK / OpenAPI). Discovery→PRD→
>    build→deploy is a single continuous rail *onto the platform*.
> 4. **Design stage = in-house.** PRD → a **WS8 design specialist** producing a real prototype,
>    using the **Creative dept** Image Studio for assets. No Figma dependency in v1.
> 5. **QA toolkit v1 = full.** Preview environments **+** automated a11y/perf (Unlighthouse +
>    Lighthouse budgets + axe) **+** E2E/visual regression (Playwright, AI-authored from the PRD).
>    Nothing deferred.
> 6. **Build sequence = Entry → Console → Webdesk.** Make audio→PRD real from the ERP first,
>    then the daily cockpit (console + work-detection), then the platform.

The goal of this document is to get the **foundation right first**: what the web-dev team actually
does end to end, what already exists (and its true status), the one unified model that ties it
together, the flagship gap (audio→PRD *from the ERP*), the per-stage tooling plan, and exactly how
it all plugs into the gaiada ERP — before the architect design doc.

> **📌 THE INSIGHT THAT SHAPES EVERYTHING (read first):** Web Dev does **not** need net-new
> invention the way Creative did (GPU) or SEO did (paid-data). It needs **welding**. Three real
> programs already exist at different maturities — the **audio→PRD delivery pipeline** (built, ran
> live, but has *no ERP entry point*), the **integrations program** (console + work-detection,
> approved and ticket-ready), and **webdesk** (the client-site platform, blueprinted, unbuilt) —
> plus a half-built **capture edge**. Today they are four things. The foundation's job is to make
> them **one department**: a continuous rail from a recorded client meeting to a live,
> maintained website, with a single cockpit the team lives in. The couplings in §4 are what turn
> four programs into one system.

---

## 1. What the Web Dev department actually does

An agency web-dev department takes a client from *"we need a website / web app"* to *"it's live and
we maintain it."* Model this as a left→right **delivery spine** of nine stages — each a distinct
workload with its own clock (discovery = one meeting; scope = days–weeks external; build = days;
maintenance = forever).

| # | Stage | What happens | Clock |
|---|---|---|---|
| 1 | **Discovery** | Client meeting(s) → understand needs → MOM, PRD, Report | minutes (once recorded) |
| 2 | **Scope / commercial** | Estimate/quote, scope agreement, dual sign-off | days–weeks (external) |
| 3 | **Design** | Wireframe → prototype → UI, on-brand assets | hours–days |
| 4 | **Build** | Code the site/app against the platform contract | days |
| 5 | **Content** | Populate the site (headless CMS) | days, then ongoing |
| 6 | **QA** | Preview, test, a11y, performance, cross-browser | continuous |
| 7 | **Deploy** | Staging → live (isolated trust zone) | minutes, gated |
| 8 | **Client review** | Portal: status, feedback, sign-offs | throughout |
| 9 | **Maintenance** | Change requests, ongoing content, ops/monitoring | forever |

---

## 2. Day-to-day deliverables

| Deliverable | Stage | Produced by / with |
|---|---|---|
| **PRD** (product requirements) | Discovery | audio→PRD pipeline (WS11) |
| **Report** (internal meeting summary) | Discovery | pipeline report track (sink TBD, §12) |
| **Scope agreement** (commercial, dual-signed) | Scope | pipeline scope track + client portal |
| **Estimate / quote** | Scope | *gap — no tooling today* |
| **Prototype / design** | Design | WS8 design specialist + Creative Image Studio |
| **Codebase** (frontend on webdesk contract) | Build | WS8 code specialist + GitHub |
| **Populated site content** | Content | webdesk (Payload headless) |
| **QA report** (a11y/perf/E2E) | QA | Unlighthouse + Lighthouse + Playwright |
| **Preview URL** | QA | per-branch staging (Zone B) |
| **Live site** | Deploy | webdesk control plane + WS10 pipeline |
| **Change-request resolution** | Maintenance | portal intake → mini-pipeline / control plane |

---

## 3. What already exists — the four pieces, true status

> Read status honestly (MODULES.md vocabulary). "Built + ran live" ≠ "usable by the team."

**A. Audio→PRD delivery pipeline (WS11) — `PROTOTYPED`, ran live end-to-end 2026-07-16.**
Far more than "1 tool." The full chain works: transcript → MOM → 3 targeted LLM extractions
(PRD / Report / Scope) → durable `pipeline_run`/`stage`/`gate` state in platform-nest → n8n
dispatcher + fan-out → PRD-sign + dual scope-sign gates → design→3-beat-Submission→code→staging
spine → **client portal** (client-role dashboard, plain-language blockage banner, sign/feedback).
Backbone rule honored: n8n orchestrates, MCP-hub accesses, services hold logic.
- **The real gap:** **no ERP entry point.** The trigger today is `meeting-bot/submit.mjs` — a
  script that POSTs a *pasted transcript* to a webhook. The engine runs; nobody on the team can
  *start it from the ERP.* This is the flagship fix (§5).
- Also stubbed by design: `design.prototype` / `code.scaffold` (synchronous placeholders),
  `github.createRepo` (fail-closed — PM makes repos), `deploy.staging` (fail-closed until URL set),
  report sink (notify stub).

**B. capture-helper (WS11 capture edge) — `IN PROGRESS` 0.2.0 — but further along than first
written (corrected 2026-07-24 by the design pass against code).**
In-ERP record → local Whisper `.txt` → ingest → Shared Drive. Verified in code: migration `0023`
`meeting_recordings` (with `transcript` + `pipeline_run_id` + `drive_*`), a `MeetingRecordingsController`
(start/patch/transcript) **including a server-side ingest proxy**, the full helper loop, and a **PRD
Studio tab with `RecordControls`** all already exist. So the entry point is more than half-built — §5
shrinks to the *run workspace* + the in-ERP audio-**upload** (server-side whisper) path + real-AI key.

**C. webdev-integrations program — Phase-1 has LANDED in the repo (corrected 2026-07-24 by the
design pass against code).** Not merely approved: migrations `0029`/`0030`/`0033` (projects
`department_id`, work-activity spine incl. consumer + backfill, `integration_connections`),
controllers, and the `components/departments/*` console template + nine tabs are all in the repo —
awaiting only the never-evidenced P1 QA gate. Phase 2 of this foundation therefore collapses to that
close-out + the external OAuth wiring. Original framing follows:
The dept **console redesign** (hybrid command-center + persistent "My work today / Waiting on me"
rail — the reusable dept-console template) + **work-detection** (GitHub org-App → task progress,
Claude usage, Drive deliverables, AI digests). Phase 1 = code-only (PM `projects.department_id`
carry-over, work-activity model from PM events, connections data model+API+Cerbos with no OAuth,
console redesign, Claude seat registry). Phase 2 = external OAuth wiring. Docs:
`plans/web-dev-integrations-plan.md`, `plans/web-dev-phase1-tickets.md`.

**D. webdesk — `PLANNED` 0.0.0, blueprint approved 2026-07-23.**
Multi-tenant client-website **backend platform**: rebranded self-hosted **Payload 3** (headless CMS)
+ NestJS forms/mail/media/control-plane, so all client sites (WordPress/Astro/Node, all full-headless)
consume **one uniform, versioned, codegen'd contract** — FE devs build only frontends. Separate
internet-facing trust zone (**Zone B**), physically split from the ERP (Zone A) across 3 boxes,
controlled one-way by the ERP over Keycloak client-credentials + mTLS; Zone B→A is signed webhooks
into the n8n bridge only. Reuses Keycloak, MCP Hub, WS4 approvals, Cerbos/RLS, WS9 observability,
WS10 pipeline. Full spec: `docs/BLUEPRINTS.md` (WebDesk Engineering Blueprint + §12 of the System
Blueprint). Phased P1 Foundation → P6 WordPress headless.

---

## 4. The unified model — two axes + the platform

The whole department is **two axes over one platform**. This is the picture the design doc builds to.

```
                 TEAM WORKSPACE (axis 2 — the cockpit the team lives in)
   ┌──────────────────────────────────────────────────────────────────────┐
   │  Dept console: command-center + "My work / Waiting on me" rail          │
   │  Work-detection: GitHub→task progress · Claude usage · Drive · digests  │
   └──────────────────────────────────────────────────────────────────────┘
        │            │           │          │         │          │
  DELIVERY SPINE (axis 1 — client-facing lifecycle, §1)
   Discovery → Scope → Design → Build → Content → QA → Deploy → Review → Maintain
        │        │       │        │        │       │      │        │        │
   ┌────▼────────▼───────▼────────▼────────▼───────▼──────▼────────▼────────▼───┐
   │                      WEBDESK — the client-site PLATFORM (Zone B)             │
   │         Payload headless CMS + control plane + codegen'd contract            │
   └─────────────────────────────────────────────────────────────────────────────┘
```

**The three couplings that make it ONE department (not three programs):**

1. **Entry coupling (§5):** `capture-helper` (record/upload in ERP) → dispatcher webhook. Turns the
   pipeline from a script-triggered engine into a *tool the team opens in the ERP.*
2. **Build coupling (decision 3):** the pipeline's `code.scaffold` generates frontends **against the
   webdesk codegen'd contract**. So a signed PRD flows straight into a scaffolded frontend that is
   *already wired to the platform* — discovery→build→deploy is one rail.
3. **Cockpit coupling (decision 6):** every spine stage emits work-activity the console surfaces
   (pipeline gates, GitHub commits, QA results, deploys) — so the team's daily view *is* the live
   state of every client engagement.

**Platform vs process vs cockpit:** webdesk is the **product** (what runs the sites), the delivery
spine is the **process** (how a client moves through), the console is the **cockpit** (where the team
works). The design doc must keep these three concerns separate but wired.

---

## 5. Flagship gap — "audio→PRD, from the ERP" (decision 2)

The single highest-leverage fix, and mostly *wiring existing parts.* Target UX, phase 1 (manual):

> A web-dev / PM person opens the ERP, on a project, hits **"New from meeting"**, and either
> **records** in-browser or **drags in an audio file**. Whisper transcribes locally (capture-helper),
> the transcript POSTs to the dispatcher, and within the ERP they watch the pipeline run and get the
> **PRD / Scope / Report back — editable, in the ERP**, with the sign-off gates already wired to the
> client portal.

What that requires (all small deltas on built parts):
- **UI:** an in-ERP capture surface on a project (record/upload) → shows pipeline-run progress →
  renders the three artifacts editable. Reuse the built `app/(app)/pipeline/` dashboard + gate inbox.
- **capture-helper → dispatcher:** post the Whisper transcript to `POST /webhook/mtg/recording-complete`
  (the frozen contract, §8 of the WS11 plan) with `tenantId`/`meetingId`/`transcript`, instead of only
  writing to Drive. Keep the Drive copy as the archive.
- **Real AI:** drop a `GEMINI_API_KEY`/`ANTHROPIC_API_KEY` in compose so `llm.extract` yields real
  PRDs (today echo-mode returns `confidence:null`). No code change (documented in the WS11 plan).
- **Editable artifacts:** persist edited PRD/Scope back to the `pipeline_stage.artifact_ref` before the
  sign gate — a small platform-nest write + UI form.

**Phase 2 (auto-join bot, deferred seam):** a bot auto-joins Meet/Zoom, records, and fires the same
dispatcher webhook — *everything downstream is unchanged* (that's why the webhook contract was frozen).
The meeting-bot provider (self-hosted Recall.ai-style vs SaaS transcriber) is the deferred decision.

---

## 6. Per-stage tooling plan

| Stage | v1 plan | Reuses / new |
|---|---|---|
| **Discovery** | audio→PRD from ERP (§5) | reuse WS11 + capture-helper; new: ERP capture UI |
| **Scope** | scope track + client portal (built); **+ estimate/quote helper** (AI draft from PRD scope + rate card) | new: quote tool (small) |
| **Design** | PRD → **WS8 design specialist** → prototype; assets from **Creative Image Studio**; sign-off gate on the prototype | new: real WS8 design specialist (replaces stub); Creative dep coupling |
| **Build** | `code.scaffold` → frontend **against webdesk contract** (typed SDK/OpenAPI); GitHub org-App detection → task progress | new: webdesk codegen contract + WS8 code specialist maturation |
| **Content** | Populate via webdesk Payload headless | webdesk P1–P3 |
| **QA** | **Preview environments** (per-branch Zone B) **+ a11y/perf** (Unlighthouse — already in SEO — + Lighthouse budgets + axe) **+ E2E/visual** (Playwright — already in platform-ui — AI-authored from PRD); results surfaced in console | new: QA harness, but reuses tools already in the estate |
| **Deploy** | `deploy.staging` → staging → live via webdesk control plane + WS10 pipeline; WS4-gated | mature the stub; wire webdesk |
| **Review** | client portal (built) — mature per-run detail | reuse |
| **Maintenance** | change-request intake in portal → mini-pipeline run / webdesk control-plane ops (MCP + WS4 approvals) | new: intake path (§12) |

**Design coupling detail (decision 4):** keeping design in-house (WS8 + Creative) ties two departments
together and avoids a Figma dependency — but the WS8 design specialist is today a *synchronous stub*.
The design doc must spec it as a real async specialist producing a viewable prototype + design assets
sourced from the Creative Render Gateway / Image Studio.

**QA note (decision 5):** nothing new needs *inventing* — Unlighthouse and Playwright already run
elsewhere in the estate. v1 = package them as a **reusable dept QA harness** that runs in CI on every
build and surfaces results in the console. Preview environments are the one genuinely new capability
(they depend on the webdesk/Zone-B deploy path, so they arrive with webdesk).

---

## 7. The team workspace layer (axis 2)

This is the "productivity like the other departments" ask, and it is **already approved and
ticket-ready** (webdev-integrations program, §3C). The foundation just confirms its place:

- **Console** = the reusable dept-console template (hybrid command-center + "My work / Waiting on me"
  rail). Web Dev is the *reference implementation*; SEO/SMM/Creative consoles inherit the pattern.
- **Work-detection** = the ERP becomes the central work-detection hub: GitHub (org App) → task
  progress, Claude usage (seat registry → Admin API), Drive deliverables, AI digests. Connection
  scope is **per-company** (RLS-consistent).
- Every delivery-spine event (pipeline gate opened, commit pushed, QA failed, deploy shipped) is a
  work-activity signal the console surfaces — this is coupling #3 from §4.

Sequence-wise (decision 6) this ships **second**, right after the pipeline entry point, so the team
feels daily productivity before the big webdesk lift.

---

## 8. AI + automation posture (reuse the estate, invent nothing)

Web Dev inherits the whole platform spine — the foundation's discipline is to **reuse, not rebuild**:
- **Orchestration:** n8n (WS4) — the pipeline workflows already exist.
- **Access:** MCP Hub (WS2) — pipeline/extraction/delivery tools already built + scoped per workflow.
- **Models:** ai-gateway-go (WS3) — `llm.*`, local-Hermes-first then cloud failover.
- **Human-in-the-loop:** WS4 approvals-suspension surface — every risky/public write (deploy to live,
  repo creation, client-facing gates) is a WS4 gate. Same posture as SMM's "mandatory HITL."
- **Agents:** WS8 design + code specialists (to be matured from stubs).
- **Trust split:** webdesk is Zone B; ERP is Zone A; one-way control; Zone B→A only via signed n8n
  webhooks. A Zone B breach can never reach company data.
- **Observability:** WS9 OTel across the pipeline + webdesk.

---

## 9. Locked decisions (2026-07-24)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Foundation scope | **Productivity + webdesk unified** — one department map |
| 2 | Capture entry | **Both, manual first** — in-ERP record/upload → dispatcher now; auto-join bot phase 2 |
| 3 | Build↔webdesk | **One rail** — `code.scaffold` builds frontends against the webdesk codegen'd contract |
| 4 | Design stage | **In-house** — WS8 design specialist + Creative Image Studio; no Figma in v1 |
| 5 | QA v1 | **Full** — preview envs + a11y/perf (Unlighthouse+Lighthouse+axe) + E2E/visual (Playwright); nothing deferred |
| 6 | Build sequence | **Entry → Console → Webdesk** |

Inherited/prior locks still in force: webdesk = Payload-headless + Zone-B one-way-control (2026-07-23);
integrations = code-first, external-OAuth-last, per-company connection scope (2026-07-22); WS11 = two
client signatures (PRD + Scope), delivery build gated on both, client portal as a role-gated dashboard,
report sink stubbed (2026-07-16).

---

## 10. Build sequence (decision 6) — phased

Each phase is a coherent, shippable increment; earlier gates later.

- **Phase 1 — Make the flagship real (ENTRY).** §5: in-ERP capture UI + capture-helper→dispatcher
  wiring + real-AI key + editable artifacts. Smallest lift, highest leverage — the pipeline becomes a
  tool the team *uses*. *(Mostly wiring built parts.)*
- **Phase 2 — The cockpit (CONSOLE).** The webdev-integrations Phase-1 tickets (already decomposed):
  console redesign + work-detection data model/API/Cerbos (no OAuth yet). Daily productivity lands.
- **Phase 3 — External wiring.** integrations Phase 2: GitHub org App, Drive OAuth, Anthropic Admin
  API, AI digests. The console fills with live signals.
- **Phase 4 — The platform (WEBDESK).** webdesk P1–P6 phased build. As it lands, wire coupling #2
  (code.scaffold → webdesk contract) and the Content/Deploy/Maintenance stages + preview environments.
- **Phase 5 — Mature the specialists + QA harness.** Real WS8 design + code specialists; the reusable
  QA harness (a11y/perf/E2E) in CI; the estimate/quote helper; maintenance change-request intake.

The architect design doc (`webdev-design.md`) turns Phases 1–2 into concrete `/army` tickets first
(they're mostly wiring + already-decomposed work), then specs 3–5.

---

## 11. Open questions (to resolve in the design doc)

- **Report → internal-process sink:** still undefined (inherited from WS11). PM ticket per
  `pm-ai-tracker-contract`? Slack/email? Decide before maturing the report track.
- **Meeting-bot provider (phase 2):** self-hosted (Recall.ai-style, we control) vs SaaS transcriber
  webhook. Deferred until the manual entry proves the flow.
- **Estimate/quote model:** where does the rate card live, and is the AI quote advisory-only or does it
  populate the scope agreement? New surface, needs a small data model.
- **webdesk contract ↔ code.scaffold shape:** exactly what the codegen contract exposes (blocks/fields
  → typed SDK) and how the code specialist consumes it. The pivotal engineering detail of coupling #2 —
  design-doc-level.
- **Maintenance intake:** portal change-request → does it spawn a *mini* pipeline run (design→build→
  deploy without re-doing discovery/scope) or go straight to the webdesk control plane for content-only
  edits? Likely both, by change type.
- **Preview-environment mechanics:** per-branch ephemeral deploy on Zone B — cost/isolation model,
  and whether clients see previews via the portal.

---

## 12. How it plugs into the ERP (reuse map)

| Need | Reuse (don't rebuild) |
|---|---|
| Data + RLS + custom fields | platform-nest ModuleContract; pipeline tables already exist (`0017`/`0018`) |
| AuthZ | Cerbos policies (pipeline/portal already written); per-company scope |
| Orchestration / access / models | n8n (WS4) / MCP Hub (WS2) / ai-gateway-go (WS3) — all wired |
| Human gates | WS4 approvals-suspension surface |
| Dept UI shell | dept-console template (Web Dev is the reference); CompanyContext + `lib/rbac.ts` |
| Client-facing | WS11 client portal (role-gated dashboard) + external Keycloak realm |
| Platform / hosting | webdesk (Zone B) + WS10 release pipeline |
| QA tools | Playwright (platform-ui) + Unlighthouse (SEO) already in the estate |
| Assets | Creative dept Image Studio / Render Gateway |
| Observability | WS9 OTel |

---

*Next step: architect design doc `webdev-design.md` (§00–§14, sibling-doc pattern) — spec Phases 1–2
into `/army` tickets first, then 3–5. Convert to a MODULES.md `webdesk`/Web-Dev entry when the design
doc starts.*
