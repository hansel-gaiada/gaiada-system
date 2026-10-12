// M5-W6 — AI assist for the writers' room: `POST …/content/sites/:tenantSlug/:siteId/items/:itemId/assist {kind, version?}`
// and the MCP tool `webdesk.content.assist`. Design: docs/plans/2026-10-11-m5-writers-room-design.md §5 (W6 row).
//
// WHAT IT IS: the ERP reads an item (as the caller), asks ai-gateway-go for suggestions, validates them, and RETURNS them. A
// human applies each one and saves it through the normal `content.update` (baseVersion and all); approval and publishing stay
// where they are. WRITES NOTHING: this file never reaches `WebdeskZoneB.write`, no `content.*` or `editorial.*` command is sent,
// and the only thing it stores is the ERP's own `activities` ledger rows (ids, kind, counts, latency).
//
// AUTHORIZATION: `update` on the item, with the item's own attributes: the two-phase gate of M5-W1c (`authorizeSite` in the
// controller, then `openItemForContent` here: the cross-company wall, WebDesk's `item.get`, `ItemGate.forItem(…, "update", attrs)`).
// A writer may ask for suggestions only on an item they may edit (their own draft); a staff editor on any item; nobody else.
// No new Cerbos kind or action. The check runs BEFORE the body is looked at, before the budget is touched and before the
// gateway is called: a denied caller costs nothing and learns nothing about the item.
//
// BOTS AND AGENTS: allowed, on the same rule (Cerbos decides `update`), with a SMALLER daily budget (webdesk-assist-budget.ts). The
// call writes nothing and returns text to the caller; an agent that wants a suggestion saved must call `content.update` itself,
// which is its own gated, classified write (and a human's approval step stays human-only: assist never touches it). The risk
// assist adds is spend, which the budget bounds per principal.
//
// ORDER: gate → wall → item.get → `update` check → body → deleted? → pick the version → build the prompt (a kind with nothing to
// work from is a typed 422, no spend) → budget reserve (typed 429) → gateway → settle → validate → 200.
//
// TYPED ANSWERS (RFC 9457 problems, `…/errors/<slug>`): 422 `assist-not-applicable` {reason} · 429 `assist-budget-exceeded`
// {scope, limits, used, retryAfterSeconds} · 503 `assist-unavailable` {reason: not_configured | gateway_unavailable | gateway_busy |
// no_provider}: the gateway could not serve it, and an empty or placeholder suggestion is NEVER presented as success · 502
// `assist-output-invalid` {reason}: the model answered but the answer failed the kind's validator (the limits are W3's).
//
// NO CONTENT IN LOGS: one line per call, `assist kind=… item=… ver=… outcome=… ms=… promptTokEst=… completionTokEst=…`. Never the
// prompt, the completion, a title, a field or an error message that could quote either (a gateway error is logged as its HTTP
// status or error name only).
import { ForbiddenException, Logger } from "@nestjs/common";
import type { Principal } from "../../rbac/principal";
import { completeViaGateway, GatewayNotConfiguredError, type CompletionResult } from "../search/providers/gateway-client";
import {
  ASSIST_KINDS, AssistNotApplicable, AssistOutputInvalid, buildPrompt, estimateTokens, isAssistKind, parseAnswer, readSource,
  type AssistKind, type BuiltPrompt, type Suggestion,
} from "./webdesk-assist";
import {
  isAutomatedPrincipal, ledgerAssistBudget, limitsFor, type AssistBudgetStore, type AssistLimits, type AssistOutcome,
} from "./webdesk-assist-budget";
import {
  WebdeskProblem, invalidRequest, strictBody, webdeskContent,
  type ContentGate, type SiteRef, type WebdeskContentService, type ZoneBResult,
} from "./webdesk-content.service";

const logger = new Logger("WebdeskAssist");

const PROBLEM_BASE = "https://webdesk.gaiada.online/errors";
const GATEWAY_TIMEOUT_MS = 30_000;

function problem(status: number, slug: string, title: string, detail: string, extra: Record<string, unknown> = {}): WebdeskProblem {
  return new WebdeskProblem(status, { type: `${PROBLEM_BASE}/${slug}`, title, status, detail, ...extra });
}

/** The gateway seam. Production: the shared ai-gateway-go client (the ONLY way this module reaches a model, and it holds no provider key). */
export type AssistGateway = (prompt: string) => Promise<CompletionResult>;
const realGateway: AssistGateway = (prompt) => completeViaGateway(prompt, { timeoutMs: GATEWAY_TIMEOUT_MS });

export interface AssistDeps {
  gateway: AssistGateway;
  budget: AssistBudgetStore;
  now: () => Date;
  limits: (principal: Principal) => AssistLimits;
}
const defaultDeps = (): AssistDeps => ({ gateway: realGateway, budget: ledgerAssistBudget, now: () => new Date(), limits: limitsFor });

/** What a gateway failure was, from the shared client's error (HTTP status in its message, never body text). */
function classifyGatewayError(err: unknown): { outcome: AssistOutcome; reason: string; log: string } {
  if (err instanceof GatewayNotConfiguredError) return { outcome: "not_configured", reason: "not_configured", log: "not_configured" };
  const status = /HTTP (\d{3})/.exec((err as Error | undefined)?.message ?? "")?.[1];
  if (status === "429") return { outcome: "gateway_unavailable", reason: "gateway_busy", log: "http_429" };
  return { outcome: "gateway_unavailable", reason: "gateway_unavailable", log: status ? `http_${status}` : ((err as Error | undefined)?.name ?? "error") };
}

export interface AssistResponse {
  kind: AssistKind;
  itemId: string;
  /** The version the suggestions were made from. A human saves with `baseVersion` = the head, and sees a 409 if the head has moved. */
  version: number | null;
  headVersion: number | null;
  locale: string;
  /** Always true: suggestions are advice. Nothing was written, and nothing is applied until a human saves it. */
  advisory: true;
  suggestions: Suggestion[];
  /** The wording a UI must show with a translated draft; absent for the other kinds. */
  notice?: string;
  /** The gateway's provider that served the call (a name, not content). */
  provider: string | null;
  usage: { callsUsed: number; callsLimit: number; tokensEstimatedUsed: number; tokensLimit: number; tokensAreEstimates: true; scope: "principal"; automated: boolean };
}

export class WebdeskAssistService {
  private deps: AssistDeps = defaultDeps();

  constructor(private readonly content: Pick<WebdeskContentService, "openItemForContent" | "readVersionBody"> = webdeskContent) {}

  /** Tests: replace any of the seams (null restores the real ones). */
  setDepsForTests(d: Partial<AssistDeps> | null): void {
    this.deps = d === null ? defaultDeps() : { ...defaultDeps(), ...d };
  }

  async assist(gate: ContentGate, site: SiteRef, itemId: string, rawBody: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "update");
    const principal = gate.principal;
    const userId = principal.userId;
    if (!userId) throw new ForbiddenException("not authorized: an authenticated user is required");

    // PHASE 2: the wall, WebDesk's item.get, and `update` with the item's own attributes. Before the body, the budget and the gateway.
    const read = await this.content.openItemForContent(gate, site, itemId, "update");

    const b = strictBody(rawBody === undefined || rawBody === null ? {} : rawBody, ["kind", "version"]);
    if (!isAssistKind(b.kind)) throw invalidRequest(`kind must be one of ${ASSIST_KINDS.join(", ")}`);
    const kind = b.kind;
    let version: number | undefined;
    if (b.version !== undefined && b.version !== null) {
      if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1 || b.version > 2_147_483_647) {
        throw invalidRequest("version must be an integer >= 1 (omit it to use the item's head version)");
      }
      version = b.version;
    }
    if (read.deleted) {
      throw problem(409, "item-deleted", "Item deleted", "This item has been deleted, so there is nothing to suggest for.");
    }

    // The content to work from: the head already in hand, or the named version (404 `version-not-found` passes through).
    const useHead = version === undefined || version === read.selectedVersion;
    const picked = useHead ? { body: read.head, locale: read.locale, collectionKey: read.collectionKey } : await this.content.readVersionBody(read.itemGate, version as number);
    const usedVersion = useHead ? read.selectedVersion : (version as number);

    const src = readSource(picked.body, picked.locale, picked.collectionKey);
    let built: BuiltPrompt;
    try {
      built = buildPrompt(kind, src);
    } catch (err) {
      if (err instanceof AssistNotApplicable) {
        logger.log(`assist kind=${kind} item=${itemId} ver=${usedVersion ?? "-"} outcome=not_applicable reason=${err.reason}`);
        throw problem(422, "assist-not-applicable", "Nothing to suggest from", "This item does not have what this kind of suggestion needs.", { reason: err.reason, kind });
      }
      throw err;
    }

    const promptTokensEst = estimateTokens(built.prompt.length);
    const limits = this.deps.limits(principal);
    const now = this.deps.now();
    const reserved = await this.deps.budget.reserve({
      tenantId: gate.tenantId, userId, kind, siteId: site.siteId, itemId, version: usedVersion, promptTokensEst, limits, now,
    });
    if (!reserved.ok) {
      logger.warn(`assist kind=${kind} item=${itemId} outcome=budget_exceeded callsUsed=${reserved.before.calls} tokensEstUsed=${reserved.before.tokens}`);
      throw problem(429, "assist-budget-exceeded", "Daily AI assist budget used up", "You have used today's AI suggestions. The budget resets at 00:00 UTC.", {
        scope: "principal", limits, used: { calls: reserved.before.calls, tokensEstimated: reserved.before.tokens }, retryAfterSeconds: reserved.retryAfterSeconds,
      });
    }

    const settle = (outcome: AssistOutcome, completionTokensEst: number, latencyMs: number, suggestions: number, provider: string | null) =>
      this.deps.budget
        .settle({
          tenantId: gate.tenantId, userId, reservationId: reserved.reservationId, kind, siteId: site.siteId, itemId, outcome,
          completionTokensEst, promptTokensEst, latencyMs, suggestions, provider,
        })
        .catch((err) => logger.error(`assist ledger row could not be written (${(err as Error)?.name ?? "error"})`));

    const started = Date.now();
    let completion: CompletionResult;
    try {
      completion = await this.deps.gateway(built.prompt);
    } catch (err) {
      const c = classifyGatewayError(err);
      const ms = Date.now() - started;
      await settle(c.outcome, 0, ms, 0, null);
      logger.warn(`assist kind=${kind} item=${itemId} ver=${usedVersion ?? "-"} outcome=${c.outcome} cause=${c.log} ms=${ms} promptTokEst=${promptTokensEst}`);
      throw problem(503, "assist-unavailable", "AI assist is unavailable", "The AI service could not answer. Nothing was suggested and nothing was changed; try again later.", { reason: c.reason });
    }
    const ms = Date.now() - started;
    const text = typeof completion?.text === "string" ? completion.text : "";
    const provider = typeof completion?.provider === "string" ? completion.provider : null;

    // `echo` is the gateway's keyless terminator: it answers with the prompt's own words when no real provider is up. That is
    // not a suggestion. (The prompt echoed back would also fail every validator; this names the cause.)
    if (provider === "echo") {
      await settle("no_provider", 0, ms, 0, provider);
      logger.warn(`assist kind=${kind} item=${itemId} ver=${usedVersion ?? "-"} outcome=no_provider ms=${ms}`);
      throw problem(503, "assist-unavailable", "AI assist is unavailable", "No AI provider is available right now. Nothing was suggested.", { reason: "no_provider" });
    }

    const completionTokensEst = estimateTokens(text.length);
    let suggestions: Suggestion[];
    try {
      suggestions = parseAnswer(kind, text, built);
    } catch (err) {
      if (err instanceof AssistOutputInvalid) {
        await settle("output_invalid", completionTokensEst, ms, 0, provider);
        logger.warn(`assist kind=${kind} item=${itemId} ver=${usedVersion ?? "-"} outcome=output_invalid reason=${err.reason} ms=${ms} promptTokEst=${promptTokensEst} completionTokEst=${completionTokensEst}`);
        throw problem(502, "assist-output-invalid", "The suggestion was not usable", "The AI answered, but not in a form that fits this page's rules. Nothing was suggested; try again.", { reason: err.reason, kind });
      }
      throw err;
    }

    await settle("served", completionTokensEst, ms, suggestions.length, provider);
    logger.log(`assist kind=${kind} item=${itemId} ver=${usedVersion ?? "-"} outcome=served n=${suggestions.length} ms=${ms} promptTokEst=${promptTokensEst} completionTokEst=${completionTokensEst}`);

    const body: AssistResponse = {
      kind,
      itemId,
      version: usedVersion,
      headVersion: read.headVersion,
      locale: read.locale,
      advisory: true,
      suggestions,
      ...(kind === "translate_draft" ? { notice: "First draft — needs a human" } : {}),
      provider,
      usage: {
        callsUsed: reserved.before.calls + 1,
        callsLimit: limits.calls,
        tokensEstimatedUsed: reserved.before.tokens + promptTokensEst + completionTokensEst,
        tokensLimit: limits.tokens,
        tokensAreEstimates: true,
        scope: "principal",
        automated: isAutomatedPrincipal(principal),
      },
    };
    return { status: 200, body: body as unknown as Record<string, unknown> };
  }
}

export const webdeskAssist = new WebdeskAssistService();
