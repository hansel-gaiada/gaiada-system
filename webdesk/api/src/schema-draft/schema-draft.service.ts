// WSK-32 — AI schema drafting: PRD -> validated composition proposal + diff summary. NEVER writes
// `collections` or any other domain table — the ONLY write this service performs is an audit_entries
// row (both on acceptance and on rejection), via the shared AuditService (../audit/audit.service.ts,
// unedited). A schema change only ever reaches the database through the pre-existing, unmodified
// `../control/schema/schema.controller.ts` (`schema.propose` structural draft, then `schema.apply`
// — impact class `medium`, WS4-assertion-gated per design §03 Layer 4). This file's output
// (`proposedSchema`) is shaped to be pasted straight into that endpoint's `{schema: ...}` body by
// the human reviewer — this service never calls it.
//
// Reject vs accept, and what "zero side effects on reject" means here: an invalid draft (unknown
// block/field type, malformed shape, or a model response that wasn't parseable JSON at all) is
// NEVER written to `collections` — that was already true even for a syntactically valid but
// out-of-vocabulary proposal, because nothing in this file ever touches that table. The one thing
// that DOES happen on every attempt, valid or not, is the audit row — matching
// `../control/schema/schema.service.ts`'s own `schema.propose` precedent (also draft-only, also
// audited every time) and the estate-wide rule "every command gets one" (design §04/§11).
import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { TenantLookupService } from "../tenants/tenant-lookup.service";
import { AuditService } from "../audit/audit.service";
import { buildDiffSummary, type DiffSummary } from "./diff-summary";
import { buildSchemaDraftPrompt } from "./prompt";
import { parseModelCompositionOutput } from "./parse-model-output";
import { validateCollectionComposition, type CollectionComposition, type CompositionIssue } from "./vocabulary-vendor";
import { HttpGatewayCompleter, type GatewayCompleter } from "./gateway-client";

export interface SchemaDraftResult {
  collectionKey: string;
  /** The proposal object — present even when invalid, so a reviewer/log can see exactly what the
   *  model produced and why it was refused. `null` only when the model's raw output could not be
   *  parsed as JSON at all (nothing structural to show). */
  proposedSchema: CollectionComposition | Record<string, unknown> | null;
  currentSchema: CollectionComposition | null;
  validation: { valid: boolean; issues: CompositionIssue[] };
  /** `null` whenever `validation.valid` is false — a diff against an invalid proposal would be
   *  meaningless (it might not even be a composition-shaped object), and the ticket's own AC is
   *  explicit that a rejected proposal produces nothing for a human to approve. */
  diff: DiffSummary | null;
  /** Always false — this service never writes `collections`. Restated as a field (not just
   *  documented) so a caller/test can assert it directly rather than trusting a comment. */
  persisted: false;
}

@Injectable()
export class SchemaDraftService {
  private readonly completer: GatewayCompleter;

  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantLookupService,
    private readonly audit: AuditService,
    @Optional() completer?: GatewayCompleter,
  ) {
    this.completer = completer ?? new HttpGatewayCompleter();
  }

  private async resolveActiveTenant(slug: string) {
    const tenant = await this.tenants.bySlug(slug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException("tenant not found");
    return tenant;
  }

  private async fetchCurrentComposition(tenantId: string, siteId: string, collectionKey: string): Promise<CollectionComposition | null> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ schema: CollectionComposition }>(
        `SELECT schema FROM collections WHERE tenant_id = $1 AND site_id = $2 AND key = $3`,
        [tenantId, siteId, collectionKey],
      );
      return rows[0]?.schema ?? null;
    });
  }

  private async recordAttempt(opts: { tenantId: string; actor: string; collectionKey: string; valid: boolean; destructive: boolean }): Promise<void> {
    await this.db.withTenant(opts.tenantId, (db) =>
      db.transaction((client) =>
        this.audit.record(client, {
          tenantId: opts.tenantId,
          actor: opts.actor,
          action: opts.valid ? "webdesk.schema.aiDraft" : "webdesk.schema.aiDraft.rejected",
          args: { collectionKey: opts.collectionKey, valid: opts.valid, destructive: opts.destructive },
        }),
      ),
    );
  }

  /**
   * Validates an already-obtained candidate composition (skips the gateway call) and builds its
   * diff summary against `current`. Pure apart from the vendored validator/diff builder — no
   * network, no database. Exposed separately from `draftFromPrd` so the reject/positive-control
   * test matrix can exercise the validation+diff seam deterministically, and so a caller that
   * already has a candidate (e.g. a human-edited counter-proposal) does not have to round-trip
   * through the AI gateway to re-check it.
   */
  validateAndDiff(collectionKey: string, current: CollectionComposition | null, candidate: unknown): {
    validation: { valid: boolean; issues: CompositionIssue[] };
    diff: DiffSummary | null;
  } {
    const validation = validateCollectionComposition(collectionKey, candidate);
    if (!validation.valid) return { validation, diff: null };
    return { validation, diff: buildDiffSummary(collectionKey, current, candidate as CollectionComposition) };
  }

  /** The full flow: PRD -> gateway `llm.extract(kind=webdesk_schema)` -> parse -> vendored
   *  vocabulary validation -> diff summary. Never persists. */
  async draftFromPrd(input: { tenantSlug: string; siteId: string; collectionKey: string; prd: string; actor: string }): Promise<SchemaDraftResult> {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const current = await this.fetchCurrentComposition(tenant.id, input.siteId, input.collectionKey);

    const prompt = buildSchemaDraftPrompt({ collectionKey: input.collectionKey, prd: input.prd, currentSchema: current });
    const raw = await this.completer.complete(prompt);
    const parsed = parseModelCompositionOutput(raw);

    if (!parsed.ok) {
      await this.recordAttempt({ tenantId: tenant.id, actor: input.actor, collectionKey: input.collectionKey, valid: false, destructive: false });
      return {
        collectionKey: input.collectionKey,
        proposedSchema: null,
        currentSchema: current,
        validation: { valid: false, issues: [{ path: "$", message: parsed.reason }] },
        diff: null,
        persisted: false,
      };
    }

    const { validation, diff } = this.validateAndDiff(input.collectionKey, current, parsed.value);
    await this.recordAttempt({
      tenantId: tenant.id,
      actor: input.actor,
      collectionKey: input.collectionKey,
      valid: validation.valid,
      destructive: diff?.destructive ?? false,
    });

    return {
      collectionKey: input.collectionKey,
      proposedSchema: (parsed.value as CollectionComposition | Record<string, unknown>) ?? null,
      currentSchema: current,
      validation,
      diff,
      persisted: false,
    };
  }
}
