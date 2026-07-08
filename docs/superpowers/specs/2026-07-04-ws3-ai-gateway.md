# Workstream 3 — AI Gateway / Provider Router

**Date:** 2026-07-04
**Status:** Design draft (brainstorming stage — not being built yet)
**Parent:** `2026-07-04-gaiada-ai-platform-roadmap.md` (Workstream 3)
**Relationship:** Formalizes and generalizes the WA bot's `CapabilityRouter` (`2026-07-04-whatsapp-automation-bot-design.md` §3) into a shared, program-wide service.
**Scope:** All outbound AI/third-party access — provider routing + failover AND the egress security boundary ("intercept access, load balancing, security" from the diagram).

---

## 1. Two merged responsibilities

1. **Provider routing (the `CapabilityRouter`):** capability chains per capability (`llm`, `vision`, `transcribe`, `docs`, …), **local-first → paid-cloud failover**, circuit breakers + health probes, **cost cap + alert**.
2. **Egress security boundary:** the single controlled door for all outbound AI/third-party calls — **API-key custody, load balancing, data-egress policy (DLP), audit, "intercept access."**

**Boundary vs MCP:** MCP = internal company tools/data; **Gateway = external AI-provider egress.** MCP's AI-backed tools call the Gateway. The Gateway is where data leaves the building → it enforces egress policy.

---

## 2. Topology — DECIDED

- **Per-site Gateway:** routes to that site's **LOCAL models first** (stays local, low latency); handles local failover among local model replicas.
- **Central cloud-egress chokepoint:** any **cloud/third-party** call is funneled through **one central egress** — the single place for **API keys, audit, DLP, rate control**. Best security/control for the sensitive external boundary.
- Flow: `caller → per-site Gateway → (local model) or (→ central egress → provider)`.

---

## 3. Egress data policy — DECIDED (redact + policy-gate + audit)

Before any **external** call, the central egress applies:
- **Redaction/masking** of sensitive fields (PII, secrets, cross-tenant data).
- **Allowlist** of what data may go to which provider.
- **Audit** of every egress (caller, OBO user, provider, payload class, redactions applied, cost).

**Local models receive full data; external providers receive policy-filtered data.** This protects private company data on the cloud-failover path (consistent with the all-local-first, cloud-only-on-failover model).

---

## 4. Key custody

- Provider API keys (Claude/Gemini-paid/Magnific/Meta/…) held **only at the central egress**, injected server-side from the **secrets vault** (WS7).
- **Internal services never see keys** — they call the Gateway's capability API; the Gateway attaches credentials at the egress boundary.

---

## 5. Capability API (uniform, shared)

The concrete shared implementation of the bot spec's capability interfaces. Callers (MCP tools, WA bot, platform, N8N) use one uniform API:
- `llm.chat` / `llm.summarize` (with tool-calling), `vision.describe`, `transcribe`, `docs.extract`, `image.enhance` (Magnific), …
- **Provider registry:** config-driven **ordered chains per capability** (e.g. `llm: [local_ollama, gemini_paid]`), hot-swappable (see bot spec §3). Switching local-primary/paid-fallback is a config change.

---

## 6. Load balancing

- Across **local model replicas** (e.g. multiple Ollama instances) per site.
- Across **provider accounts/keys** at the egress (respect per-provider rate limits).
- Health-aware: unhealthy providers skipped via circuit breaker; recovered providers reinstated by background probe.

---

## 7. Cost governance (program-wide)

- **Cost cap + alert** generalized from the bot: per-provider and per-tenant budgets; on breach → alert (management group + logs) and **degrade** (stop paid → placeholders) rather than incur unbounded spend. Same alert path as sync-lag / security alerts.

---

## 8. Observability & audit

- Metrics: latency, tokens, cost, failover events, per-provider health, redaction counts.
- **Every call audited** (via the tamper-evident audit trail): caller service, OBO end-user, capability, provider used (local vs cloud), cost, egress policy applied.

---

## 9. Security posture

- On the zero-trust floor (mTLS, allowlist, no public listeners); the central egress is a hardened chokepoint.
- Only authenticated internal services may call the Gateway; each call carries the OBO principal for audit + (future) per-user egress policy.

---

## 9b. D8 resolution — make the chokepoint enforced, not voluntary (LOCKED, adversarial review)

The Gateway is only a control if it cannot be bypassed and cannot leak.

1. **No keys outside the Gateway.** Bot/agents/services never hold provider keys — they always call the Gateway, which alone holds **scoped, short-TTL creds** (Vault dynamic where possible). Set **per-key spend caps at the provider** (Anthropic/Google) so a stolen/leaked key is bounded. The WA bot's in-process `CapabilityRouter` (bot spec §3) is **superseded by the remote Gateway** — the bot holds no keys.
2. **DLP fail-closed, launch-gated, media included.** Redaction + PAN-block run before any egress; on classifier-unavailable/unsure over sensitive content → **BLOCK**. Explicit **media DLP** (classify extracted text; block or on-prem-only for regulated images/docs). **No private-chat cloud egress until DLP + consent are live** (ties D2).
3. **Deterministic egress floor (non-voluntary).** Default-deny outbound; only the Gateway path reaches the internet, to **allowlisted provider FQDNs**; DNS via a controlled resolver; media/ingestion workers get **zero direct internet**; a SIEM/monitor rule treats any non-Gateway public egress as an incident. Enforce at whatever level the managed host supports in v1; tighten as infra matures.
4. **Google Drive through the governed boundary.** Route Drive I/O through the audited connector (or wrap its MCP behind the company hub) so company-data flows to/from Drive get the same DLP + audit as provider egress — no ungoverned side door.

## 10. Open items
- Concrete redaction/DLP ruleset + classifier (pattern-based + model-assisted?).
- Per-tenant vs global provider budgets + how alerts escalate.
- Whether the central egress is itself HA-paired (it is a chokepoint → needs redundancy; likely yes, per WS7).
- Streaming responses (token streaming) pass-through semantics.
- Provider-specific adapters catalog (Gemini, Claude, Magnific, local Ollama, Whisper) + their health-probe definitions.
