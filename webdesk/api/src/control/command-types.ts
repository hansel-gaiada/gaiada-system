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
  | "contract.read"
  // WSK-41 — the content authoring commands (write-plane design §3.1). Every one carries an
  // editorial principal (EDITORIAL_COMMANDS below).
  | "content.create"
  | "content.update"
  | "content.restoreVersion"
  | "content.publish"
  | "content.schedule"
  | "content.unpublish"
  | "content.delete"
  // WSK-46 — draft preview (owner ruling WSK-D52): a short-lived bearer token for ONE version of one
  // item, read at GET /v1/t/:tenantSlug/preview/:token. Both carry an editorial principal.
  | "content.previewToken"
  | "content.previewTokenRevoke"
  // WSK-51 — the editor read commands (design §4). Registered here by WSK-41 so the registry is
  // one change; WSK-51 builds their handlers.
  | "tenant.list"
  | "collection.list"
  | "collection.get"
  | "item.list"
  | "item.get"
  | "item.versions"
  | "item.versionGet"
  | "media.list"
  // WSK-43a — the media library (owner rulings WSK-D53/D54). The three writes carry an editorial principal.
  | "media.uploadToken"
  | "media.update"
  | "media.delete"
  | "media.usage";

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
  // WSK-41 (design §3.1, rulings WSK-D45/D46). Draft writes are MEDIUM/operate: a draft is never
  // live (content_items is the live projection; a version is the working copy). publish/schedule
  // are HIGH for EVERY principal class, so the PolicyDecisionPoint demands a WS4 assertion.
  // unpublish/delete are MEDIUM under the promote scope: they reduce exposure and are restorable,
  // and a takedown must not wait for a second person (D46).
  "content.create": { command: "content.create", impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "content.update": { command: "content.update", impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "content.restoreVersion": { command: "content.restoreVersion", impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "content.publish": { command: "content.publish", impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "content.schedule": { command: "content.schedule", impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "content.unpublish": { command: "content.unpublish", impactClass: "medium", scope: "webdesk:promote", jobTracked: false },
  "content.delete": { command: "content.delete", impactClass: "medium", scope: "webdesk:promote", jobTracked: false },
  // WSK-46: minting a preview token EXPOSES UNPUBLISHED CONTENT to whoever holds the link, so it is a
  // write (never `read`), MEDIUM/operate like the other draft writes: nothing goes live, and the link
  // is time-boxed (default 1h, max 24h) and revocable. The revoke is the matching takedown and sits on
  // the same scope, so whoever may mint a link may withdraw it (it only ever reduces exposure).
  "content.previewToken": { command: "content.previewToken", impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "content.previewTokenRevoke": { command: "content.previewTokenRevoke", impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  // WSK-51 (design §4): live editor reads. read/webdesk:read, no editorial assertion, not audited.
  "tenant.list": { command: "tenant.list", impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "collection.list": { command: "collection.list", impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "collection.get": { command: "collection.get", impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "item.list": { command: "item.list", impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "item.get": { command: "item.get", impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "item.versions": { command: "item.versions", impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "item.versionGet": { command: "item.versionGet", impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "media.list": { command: "media.list", impactClass: "read", scope: "webdesk:read", jobTracked: false },
  // WSK-43a (design: m3 plan, "The media library"). An upload token lets whoever holds it put ONE file into the
  // tenant's public library, so minting is a write (never `read`): MEDIUM/operate like the other draft writes
  // (nothing goes live; the token is time-boxed to ten minutes, single-use, size- and type-capped). Update and
  // delete are MEDIUM/operate too: a delete is soft (the stored object is kept until its retention lapses) and
  // is REFUSED while content uses the asset (D54), so it cannot break a page, and, unlike content.delete, it
  // takes no takedown scope. media.usage is a plain read.
  "media.uploadToken": { command: "media.uploadToken", impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "media.update": { command: "media.update", impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "media.delete": { command: "media.delete", impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "media.usage": { command: "media.usage", impactClass: "read", scope: "webdesk:read", jobTracked: false },
});

/**
 * WSK-41 (design §3.1) — the commands that write content and therefore carry an editorial
 * principal (WSK-40's signed assertion; a dev-mode header in tests). EditorialAssertionGuard refuses
 * to run on a route whose command is not in this set, and every ContentCommandsService method takes
 * an EditorialCommandContext (which holds the EditorialPrincipal), so a content route that forgets
 * the guard has no principal to hand the service and does not compile.
 * test/control-command-registry.spec.ts pins the exact membership.
 */
export const EDITORIAL_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  "content.create",
  "content.update",
  "content.restoreVersion",
  "content.publish",
  "content.schedule",
  "content.unpublish",
  "content.delete",
  "content.previewToken",
  "content.previewTokenRevoke",
  "media.uploadToken",
  "media.update",
  "media.delete",
]);

export function commandMeta(command: CommandName): CommandMeta {
  return COMMAND_REGISTRY[command];
}

/**
 * WSK-49b (ruling WSK-D59) — the editorial commands a CLIENT editor may run, an ALLOW-list: a command added
 * to EDITORIAL_COMMANDS later is refused to a client until it is listed here on purpose. "A client editor" is
 * a principal whose signed editorial assertion carries `ce: true` (auth/client-editor.ts).
 *
 *   allowed   content.create / update / restoreVersion  (each still held to the client-editable paths, D59,
 *                                                         in content-commands.service.ts)
 *             content.publish                            (WS4 + the editorial checks as for staff; WSK-D58's
 *                                                         approval flow is the ERP's, WebDesk adds nothing)
 *             content.previewToken / previewTokenRevoke  (a client previews its own draft; revoke only withdraws)
 *             media.uploadToken / media.update           (put a file in, describe it)
 *   refused   content.delete, content.unpublish, content.schedule, media.delete
 *
 * These are DESIGN DEFAULTS in the spirit of D59 ("schema, media deletion and other companies are never
 * reachable"), not owner rulings: the owner may widen the list. Nothing else a client could name is an
 * editorial command: schema.apply, key.*, lifecycle, releases and promotion carry no editorial assertion at
 * all, so a client principal cannot be expressed there (see the README, "Client editors (WSK-49)").
 */
export const CLIENT_EDITOR_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  "content.create",
  "content.update",
  "content.restoreVersion",
  "content.publish",
  "content.previewToken",
  "content.previewTokenRevoke",
  "media.uploadToken",
  "media.update",
]);
