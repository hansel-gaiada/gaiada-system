// WSK-21 — the control-plane's own vocabulary for "what kind of command is this and how much
// gate does it need" (design §03 Layer 3 scopes, §07's impact-class table, restated for the
// actual C-05 command set this ticket builds — lifecycle · schema · keys · release · rebuild).
//
// Pure types/data — no NestJS decorators — so it can be imported by both the runtime guards
// (policy/command-authorization.guard.ts) and a test (test/control-command-registry.spec.ts)
// that asserts the map matches the design doc, without dragging in half the module graph to do
// it.

export type ImpactClass = "read" | "medium" | "high";

// §03 Layer 3: "Zone B Cerbos sidecar ... authorizes every command against the token's scopes
// (webdesk:read, webdesk:operate, webdesk:promote, webdesk:keys) regardless of caller."
export type ControlScope = "webdesk:read" | "webdesk:operate" | "webdesk:promote" | "webdesk:keys";

export type CommandName =
  | "tenant.provision"
  | "tenant.archive"
  | "site.provision"
  | "site.archive"
  | "environment.provision"
  | "environment.archive"
  | "schema.propose"
  | "schema.aiDraft"
  | "schema.apply"
  | "content.export"
  | "content.promote"
  | "content.rollback"
  | "key.mint"
  | "key.rotate"
  | "key.revoke"
  | "release.deploy"
  | "release.promote"
  | "release.rollback"
  | "release.triggerRebuild"
  | "job.get"
  | "job.list"
  | "contract.read";

export interface CommandMeta {
  readonly command: CommandName;
  readonly impactClass: ImpactClass;
  readonly scope: ControlScope;
  /** True for release.deploy/promote/rollback/triggerRebuild — returns a jobId, not a final result. */
  readonly jobTracked: boolean;
}

/**
 * THE impact-class map. `policy/command-authorization.guard.ts` enforces this at runtime;
 * `test/control-command-registry.spec.ts` asserts it against the design table entry-by-entry.
 *
 * Two deliberate departures from design §07's literal table, both documented there and repeated
 * here so a future reader does not "fix" them back to a mismatch:
 *
 *   - `schema.propose` is classified `read`, not §07's separate "LOW write (draft)" tier — this
 *     ticket's own brief narrows the AC to three tiers ("read / medium write / HIGH write").
 *     Justified because propose never persists anything (§05: "draft only, never applies");
 *     nothing durable changes, which is what `read` means everywhere else in this map.
 *   - `job.get` / `job.list` are this ticket's own addition (the design doc's C-05 list has no
 *     "check job status" command because §07's table predates job-tracking being spelled out as
 *     an AC here) — classified `read` since they only ever inspect state a real command already
 *     produced and audited.
 */
export const COMMAND_REGISTRY: Readonly<Record<CommandName, CommandMeta>> = Object.freeze({
  "tenant.provision": { command: "tenant.provision", impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "tenant.archive": { command: "tenant.archive", impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "site.provision": { command: "site.provision", impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "site.archive": { command: "site.archive", impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "environment.provision": { command: "environment.provision", impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "environment.archive": { command: "environment.archive", impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "schema.propose": { command: "schema.propose", impactClass: "read", scope: "webdesk:read", jobTracked: false },
  // WSK-33 FIX — this entry exists because the P5 gate proved its absence was an authorization
  // hole. SchemaDraftController's route carried NO @Command metadata, so CommandAuthorizationGuard
  // was structurally never in its guard chain and ANY authenticated control-channel principal —
  // including one presenting ZERO scopes — could invoke AI schema drafting for ANY tenant. The
  // sibling `schema.propose` on the same resource shape DID refuse a scopeless caller, which is
  // what made this a genuine gap rather than "nothing here checks scopes".
  // Classified `read` / `webdesk:read` to MATCH schema.propose: an AI draft persists no domain row
  // (only its own audit entry), so it is a read-class advisory call, not a write. It must still be
  // scope-gated, because it reads a tenant's current collection schema and spends real LLM budget.
  "schema.aiDraft": { command: "schema.aiDraft", impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "schema.apply": { command: "schema.apply", impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  // WSK-25 unification (owner ruling 2026-08-27) — these three shipped with their OWN imperative
  // scope/WS4 check in promotion-authorization.ts. That check worked and was immune to the
  // disarmed-guard trap, but it left three control commands INVISIBLE to this registry's
  // exhaustive `Record<CommandName, ...>` in test/control-command-registry.spec.ts — the type that
  // caught the `schema.aiDraft` omission at compile time. Two authorization systems means a fourth
  // promotion command can ship unclassified and nothing complains. One source now.
  //
  // The classifications reproduce the imperative behaviour EXACTLY: export was `webdesk:read` with
  // no WS4; promote/rollback were `webdesk:promote` and ALWAYS required a WS4 assertion — which is
  // precisely what impactClass "high" means to the PolicyDecisionPoint (`high` && !ws4ApprovalId
  // => refuse). Nothing was loosened to fit the registry's shape.
  "content.export": { command: "content.export", impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "content.promote": { command: "content.promote", impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "content.rollback": { command: "content.rollback", impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "key.mint": { command: "key.mint", impactClass: "high", scope: "webdesk:keys", jobTracked: false },
  "key.rotate": { command: "key.rotate", impactClass: "high", scope: "webdesk:keys", jobTracked: false },
  "key.revoke": { command: "key.revoke", impactClass: "high", scope: "webdesk:keys", jobTracked: false },
  "release.deploy": { command: "release.deploy", impactClass: "medium", scope: "webdesk:operate", jobTracked: true },
  "release.promote": { command: "release.promote", impactClass: "high", scope: "webdesk:promote", jobTracked: true },
  "release.rollback": { command: "release.rollback", impactClass: "high", scope: "webdesk:promote", jobTracked: true },
  "release.triggerRebuild": { command: "release.triggerRebuild", impactClass: "medium", scope: "webdesk:operate", jobTracked: true },
  "job.get": { command: "job.get", impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "job.list": { command: "job.list", impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "contract.read": { command: "contract.read", impactClass: "read", scope: "webdesk:read", jobTracked: false },
});

export function commandMeta(command: CommandName): CommandMeta {
  return COMMAND_REGISTRY[command];
}
