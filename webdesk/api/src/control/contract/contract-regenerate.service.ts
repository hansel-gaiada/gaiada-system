// M6-P4r-b -- `contract.regenerate`: the re-run and backfill path of the live contract codegen.
//
//   POST /control/v1/tenants/:tenantSlug/contract/regenerate   one tenant
//   POST /control/v1/contract/regenerate                       every ACTIVE tenant
//
// WHEN TO USE IT. A run that failed all its attempts (the api log says so and names this command), and
// the backfill for tenants that existed before the live trigger shipped (their contracts/<slug>/latest.json
// does not exist yet). It is an operator command, deliberately NOT a deploy step: a deploy must not depend
// on, or be slowed by, Redis, RustFS and one generation per tenant.
//
// IDEMPOTENT at two levels. The command is a shared-envelope command (claim-first Idempotency-Key, audit
// row, stored replay record), so the same key answers the stored result and enqueues nothing a second time.
// And a run itself is safe to repeat: the queue coalesces a burst per tenant, the worker serialises runs per
// tenant, and regenerating a tenant whose stored contract is already current writes nothing (`unchanged`).
//
// The enqueue is the envelope's post-commit `after` step, fail-soft like the two automatic triggers. Unlike
// them the caller asked for exactly this, so the response REPORTS how many tenants were queued and how many
// were not (`enqueue`), on a fresh run only. The report is not part of the stored record: a replay carries
// `replayed: true` and no `enqueue`.
import { Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../../audit/audit.service";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";
import { CommandEnvelope } from "../command-envelope";
import { ContractCodegenTrigger, type EnqueueReport } from "../../codegen/contract-codegen.trigger";

export interface RegenerateResult {
  scope: "tenant" | "all";
  /** The active tenants a run was requested for, by slug. */
  tenants: string[];
}

@Injectable()
export class ContractRegenerateService {
  constructor(
    private readonly tenants: TenantLookupService,
    private readonly envelope: CommandEnvelope,
    private readonly auditHash: AuditService,
    private readonly codegen: ContractCodegenTrigger,
  ) {}

  async regenerate(input: { tenantSlug?: string; actor: string; idempotencyKey: string }) {
    let report: EnqueueReport | undefined;
    const after = (slugs: string[]) => async () => {
      report = await this.codegen.requestRuns(slugs, "contract.regenerate");
    };

    if (input.tenantSlug !== undefined) {
      const tenant = await this.tenants.bySlug(input.tenantSlug);
      if (!tenant || tenant.status !== "active") throw new NotFoundException("tenant not found");
      const args = { tenantSlug: input.tenantSlug };
      const out = await this.envelope.run<RegenerateResult>({
        command: "contract.regenerate",
        scope: { kind: "tenant", tenantId: tenant.id },
        scopeKey: `${input.tenantSlug}:contract.regenerate:${input.idempotencyKey}`,
        requestHash: this.auditHash.hashArgs(args),
        actor: input.actor,
        auditArgs: args,
        ws4ApprovalId: null,
        effect: async () => ({ result: { scope: "tenant", tenants: [input.tenantSlug as string] }, after: after([input.tenantSlug as string]) }),
      });
      return report ? { ...out, enqueue: report } : out;
    }

    const args = { tenantSlug: "*" };
    const out = await this.envelope.run<RegenerateResult>({
      command: "contract.regenerate",
      scope: { kind: "platform" },
      scopeKey: `platform:contract.regenerate:${input.idempotencyKey}`,
      requestHash: this.auditHash.hashArgs(args),
      actor: input.actor,
      auditArgs: args,
      ws4ApprovalId: null,
      effect: async (client) => {
        // Runs under the platform scope, which is what lets it read every tenant's slug.
        const { rows } = await client.query<{ slug: string }>(`SELECT slug FROM tenants WHERE status = 'active' ORDER BY slug`);
        const slugs = rows.map((r) => r.slug);
        return { result: { scope: "all", tenants: slugs }, after: after(slugs) };
      },
    });
    return report ? { ...out, enqueue: report } : out;
  }
}
