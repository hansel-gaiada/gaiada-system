// WSK-66 — WebDesk HIGH commands (content.publish, content.schedule, key.mint) filed as ONE WS4
// approval and executed IN-BAND when a human approves it in the ERP's Approvals inbox.
//
// Design: docs/plans/2026-10-10-webdesk-write-plane-design.md §6 (impact class, the WS4 flow, why the
// WSK-31 hub route cannot be reused), §8 (key.mint rides this executor; plaintext returned once), §9
// (the publish approval also authorises the staging rebuild — carried here, consumed by WSK-60), §12
// WSK-66 (signatures + done-when 1–6). Rulings: webdesk-design-v2.md §14 WSK-D45, D46 (HIGH for every
// principal; maker ≠ checker except a single-item self-publish, R4; R3 rebuild), D47.
//
// ── WHY IN-BAND, AND WHY NOT THE WSK-31 HUB ROUTE ────────────────────────────────────────────────
// WSK-31's HIGH routes trust the hub's WS4 gate (design fact 15), so a BFF caller would skip WS4. The
// D14 registry re-drives through mcp-hub, which must never carry a Zone B write arm. So this follows
// GH-12 (`core/github/repo-creation.ts`) exactly: decide() recognises the row by origin AND
// workflow_id, and executes synchronously, AS THE DECIDER, inside the decide request.
//
// ── WSK-60: THE REBUILD (publish → rebuild → staging, design §9) ────────────────────────────────
// Two additions, both through the same door:
//   1. After a SUCCESSFUL `content.publish` the executor makes ONE call, `startSiteRebuild`
//      (site-builds.service.ts), authorised by this approval's id (R3). It never throws and a failure
//      never fails the publish: the build row goes `failed` with a typed reason and the publish stands.
//      `content.schedule` does not rebuild: nothing is public yet; the scheduled publish that makes it
//      public is WSK-61's.
//   2. `content.rebuild`, a fourth member of the CLOSED union, filed by the editor after an unpublish
//      (which has no approval of its own). It sends nothing to Zone B and needs no editorial assertion:
//      its whole effect is the dispatch. AUTHORISATION: `github_repo · deploy` (the dispatch's own D14
//      rule, workflow-dispatch.ts), not `webdesk_content_item · publish`, because (a) a rebuild changes no
//      WebDesk content (the takedown it propagates was already authorised, at unpublish), so publish's
//      maker ≠ checker has nothing to guard, and (b) it adds no Cerbos action to a policy this ticket
//      does not own. Filing needs only `request_publish` (the editor tier); the generic `decide` gate
//      (company_admin) still applies at decide().
//
// ── THE ORDER IN decide() (automation-approvals.controller.ts) ───────────────────────────────────
//   1. generic `decide` (unchanged; company_admin);
//   2. `preflightWebdeskApprovedCommand` — parse the STORED tool_args, authorize the decider against
//      the command's own Cerbos rule, check the channel and signer are configured. A refusal here is
//      403/400/503 and the row stays `pending`: nothing was decided and Zone B received nothing.
//   3. the decide UPDATE (status → approved, execution_status → pending) — the single-use guard;
//   4. `executeApprovedWebdeskCommand` — re-authorizes (defence in depth), CLAIMS pending → executing,
//      sends exactly ONE write, and records `executed` / `failed` with a typed token.
//
// ── AUTHORIZATION AT EXECUTION (as the decider, never the requester) ─────────────────────────────
//   content.publish / content.schedule → webdesk_content_item · publish / schedule, with
//     approvalId = this row's id, creatorId = the row's requested_by (the maker), and itemCount =
//     the number of items in the STORED row (never a client value). itemCount == 1 is what lets R4's
//     self-publish through; anything else keeps maker ≠ checker (resource_webdesk_content_item.yaml).
//   key.mint → webdev_provisioned_site · promote (WSK-31's existing kind and action), plus an in-code
//     requester ≠ decider check, because that rule has no maker-checker arm and this ticket may not
//     edit the policy. A key mint is never self-approvable.
//
// ── NO SECOND ATTEMPT, EVER ──────────────────────────────────────────────────────────────────────
// A WS4 write is not resent (the egress client's own rule). After an ambiguous failure (the request
// may have been delivered and the answer lost, or Zone B answered 5xx), a content command RECONCILES
// BY READING each item's state (`item.get`, WSK-51): if every item is in the requested state the row is
// `executed` (reconciled), otherwise `failed`. key.mint cannot be reconciled (the plaintext would be
// gone anyway), so it fails `webdesk_ambiguous` and an operator revokes whatever key Zone B's audit
// shows under this approval id. D14's /retry cannot re-drive these rows either: the D14 executor
// refuses any origin outside automation|agent (`approval-execute.ts`).
//
// ── THE COMMAND BINDING (done-when 5) ────────────────────────────────────────────────────────────
// At filing, `commandHash` = computeCommandHash(command, params ∪ body) of the exact Zone B request is
// stored in tool_args. At execution the request is rebuilt from the stored args; the WS4 assertion
// is minted over the request as sent (the egress client does that), and the EDITORIAL assertion's
// `cmh` is bound to the FILED hash. If tool_args were edited after filing, Zone B recomputes the hash
// from what it received, finds `cmh` disagrees, and refuses 403 `editorial-assertion-command-mismatch`
// before writing anything; the row goes `failed`. key.mint carries no editorial assertion (it is not
// an EDITORIAL_COMMAND, design §3.1), so the same comparison is made HERE, before any egress.
//
// ── KEY CUSTODY (done-when 6) ────────────────────────────────────────────────────────────────────
// The minted plaintext is returned ONCE, in the decide() response. It is never written to
// automation_approvals (execution_result holds the key id only), never to activities, never to a log
// line, never to an error message. Nothing in this file logs a response body.
//
// ── THE EDITORIAL-ASSERTION SEAM (WSK-40) ────────────────────────────────────────────────────────
// `EditorialAssertionSigner` is the typed seam WSK-40 fills (`webdesk-editorial-signer.ts`, Ed25519,
// design §5). Until then the default refuses with 503 `webdesk_editorial_signer_not_configured`, so a
// content command can never leave the ERP unsigned. WSK-40 binds the real one with
// `registerEditorialAssertionSigner()` at boot; tests inject a double.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { newId, withTenants } from "../../db";
import { authorize, writeActivity } from "../../core/http";
import { insertAutomationApprovalRow } from "../../core/approval-filing";
import { emitEvent } from "../../events/outbox.service";
import { notifyBestEffort } from "../../core/client-notify";
import { resolveWebdeskApprovalDeciders } from "../../core/approval-deciders";
import { EXECUTION_RESULT_MAX_CHARS } from "../../core/approval-execute";
import type { Principal } from "../../rbac/principal";
import type { Resource } from "../../rbac/cerbos";
import {
  EditorialUnavailableError,
  WebdeskControlNotConfiguredError,
  WebdeskControlTokenError,
  WebdeskControlTransportError,
  getWebdeskControlClient,
  type WebdeskControlClient,
  type WebdeskControlResponse,
} from "./webdesk-control-client";
import { commandArgsAsZoneBSeesThem, computeCommandHash } from "./webdesk-ws4-assertion";
import { WorkflowDispatchError, authorizeDeploy } from "../../core/github/workflow-dispatch";
import { rebuildTargetFor, startSiteRebuild } from "./site-builds.service";

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The closed allow-list
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** The ONLY commands this executor runs. A closed union: a fourth command cannot ride it silently,
 *  because every table below is a `Record<WebdeskApprovedCommand, …>` and fails to compile without it. */
export type WebdeskApprovedCommand = "content.publish" | "content.schedule" | "key.mint" | "content.rebuild";

/** WSK-59: the editorial writes the BFF executes immediately (not through an approval). They sign through the
 *  SAME registered signer as the approved commands; only the command name differs (design §3.1).
 *  WSK-43b added the three MEDIUM media-library writes (WebDesk's EDITORIAL_COMMANDS carries them too). */
export type WebdeskBffEditorialCommand =
  | "content.create"
  | "content.update"
  | "content.restoreVersion"
  | "content.unpublish"
  | "content.delete"
  // WSK-46: minting a draft-preview token (MEDIUM, editorial; Zone B's `content.previewToken`).
  | "content.previewToken"
  | "media.uploadToken"
  | "media.update"
  | "media.delete";

/** `automation_approvals.origin` for these rows (migration 202610101500). */
export const WEBDESK_APPROVAL_ORIGIN = "webdesk";

/** `automation_approvals.tool_name` per command (what the inbox shows). */
const TOOL_NAME: Record<WebdeskApprovedCommand, string> = {
  "content.publish": "webdesk.content.publish",
  "content.schedule": "webdesk.content.schedule",
  "key.mint": "webdesk.key.mint",
  "content.rebuild": "webdesk.content.rebuild",
};

function isApprovedCommand(value: unknown): value is WebdeskApprovedCommand {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TOOL_NAME, value);
}

/** decide()'s router: origin AND workflow_id must both match (the GH-12 / VLT-3 shape). A webdesk row
 *  whose workflow_id is outside the union is NOT routed here; decide() refuses to approve it (400). */
export function isWebdeskApprovedCommandRequest(origin: string, workflowId: string | null): boolean {
  return origin === WEBDESK_APPROVAL_ORIGIN && isApprovedCommand(workflowId);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Typed tokens (execution_error prefixes; read by the UI, never reworded — add a class instead)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export const WEBDESK_EXEC_ERROR = {
  /** Cerbos refused the decider at execution time (only reachable when preflight was bypassed or the
   *  decider's reach changed between preflight and claim). Nothing was sent. */
  denied: "webdesk_denied",
  /** The stored tool_args are malformed, outside the allow-list, or changed under the claim. Nothing sent. */
  argsInvalid: "webdesk_args_invalid",
  /** key.mint only: the stored args no longer hash to the filed commandHash. Nothing sent. */
  argsTampered: "webdesk_args_tampered",
  /** The control channel or the editorial signer is not configured. Nothing sent. */
  notConfigured: "webdesk_not_configured",
  /** The circuit breaker is open; no I/O was attempted. */
  unavailable: "webdesk_unavailable",
  /** Transport failure (or the token endpoint), provably before Zone B saw the request. */
  unreachable: "webdesk_unreachable",
  /** Zone B answered with a definitive refusal (4xx). Format: `webdesk_refused: <status> <slug>`. */
  refused: "webdesk_refused",
  /** The request may have been delivered and the answer was lost (or Zone B said 5xx), and reading
   *  the state did not confirm the requested outcome. Reconcile by hand; NEVER resend. */
  ambiguous: "webdesk_ambiguous",
  /** content.rebuild only: the dispatch did not happen. Format `webdesk_rebuild_failed: <reason>`, where
   *  the reason is one of workflow-dispatch.ts's / site-builds.service.ts's typed tokens. */
  rebuildFailed: "webdesk_rebuild_failed",
} as const;

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Shapes
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** What the approver reads in the inbox (`reason` = title). Rendered, never executed. */
export interface WebdeskApprovalSummary {
  /** One line, e.g. "Publish 3 items on gaiada.com and rebuild staging". 1..300 chars. */
  title: string;
  /** Optional per-collection counts (the M1 importer's "330 items" view). */
  counts?: Record<string, number>;
  /** Optional: the importer's bundle digest (design §8). */
  bundleSha256?: string;
}

export interface WebdeskPublishItem {
  itemId: string;
  version: number;
  /** The version's content hash as read from Zone B at filing (WSK-59). Display/audit only: Zone B's
   *  `{itemId, version}` is the binding, and the version row is immutable. */
  contentHash?: string;
}

type ParsedArgs =
  | { command: "content.publish"; tenantSlug: string; siteId: string; items: WebdeskPublishItem[]; note?: string }
  | {
      command: "content.schedule";
      tenantSlug: string;
      siteId: string;
      items: WebdeskPublishItem[];
      publishAt: string | null;
      unpublishAt: string | null;
    }
  | { command: "key.mint"; tenantSlug: string; siteId: string; envId: string; scope: "read" | "write" }
  | { command: "content.rebuild"; tenantSlug: string; siteId: string };

interface ZoneBRequest {
  command: WebdeskApprovedCommand;
  path: string;
  params: Record<string, string>;
  body: Record<string, unknown>;
}

export type WebdeskApprovedCommandResult =
  | {
      command: "content.publish" | "content.schedule";
      executionStatus: "executed";
      /** true when the answer was lost and the outcome was confirmed by READING item state. */
      reconciled: boolean;
      /** WSK-D46 R4: the decider was the requester (single-item publish only). */
      selfPublish: boolean;
      items: Array<{ itemId: string; version: number; publishedAt?: string | null }>;
      /** WSK-D46 R3: this approval also authorises the staging rebuild. WSK-60 dispatches it. */
      rebuild: { target: "staging"; approvalId: string };
      /** WSK-60: what the dispatch hook recorded (content.publish only; content.schedule never rebuilds).
       *  Absent for a schedule. A `failed` build does NOT make this result `failed`: the publish stands. */
      build?: { buildId: string | null; state: "rebuilding" | "live" | "unverified" | "failed"; failureReason: string | null };
    }
  | {
      command: "content.rebuild";
      executionStatus: "executed";
      rebuild: { target: "staging"; approvalId: string };
      build: { buildId: string | null; state: "rebuilding" | "live" | "unverified"; failureReason: null };
    }
  | {
      command: "key.mint";
      executionStatus: "executed";
      apiKeyId: string | null;
      envId: string;
      scope: "read" | "write";
      /** The ONLY copy. Never persisted, never logged. null if Zone B's 2xx carried no key. */
      plaintextOnce: string | null;
    }
  | { command: WebdeskApprovedCommand; executionStatus: "failed"; error: string };

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The editorial-assertion seam (WSK-40)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** The claims WSK-40's signer turns into a compact Ed25519 JWS (design §5). `iss`, `aud`, `iat`, `exp`
 *  and `jti` are the signer's own business; everything that binds the command is decided here. */
export interface EditorialAssertionRequest {
  /** ERP users.id of the principal Cerbos authorised: the DECIDER. */
  sub: string;
  pk: "human" | "automation" | "agent";
  agt?: string;
  ten: string;
  site: string;
  /** WSK-59 widened this from `WebdeskApprovedCommand` to also carry the MEDIUM editorial writes the
   *  BFF signs directly (design §3.1). Every signer implementation takes the string verbatim into `cmd`. */
  cmd: WebdeskApprovedCommand | WebdeskBffEditorialCommand;
  /** The FILED command hash (see this file's header): what the human approved. */
  cmh: string;
  /** The original requester (maker). */
  req?: string;
  /** The approval id; must equal the WS4 assertion's approvalId on Zone B. */
  apr?: string;
  /** WSK-49c: the client-editor marker (WebDesk's `ce` claim, WSK-D59/D62), set ONLY for a client principal. It only ever
   *  restricts: WebDesk then refuses non-client-editable changes and obeys D58 on publish. `true` or absent, never `false`. */
  ce?: true;
}

export interface EditorialAssertionSigner {
  /** false only for the not-configured default. decide()'s preflight refuses (503) on false, so the
   *  row stays pending rather than becoming approved-but-unsendable. */
  readonly configured: boolean;
  sign(input: EditorialAssertionRequest): string | Promise<string>;
}

export class EditorialSignerNotConfiguredError extends Error {
  readonly status = 503;
  readonly code = "webdesk_editorial_signer_not_configured";
  constructor() {
    super("WebDesk editorial-assertion signer is not configured (WSK-40); a content command cannot be sent unsigned");
    this.name = "EditorialSignerNotConfiguredError";
  }
}

/** The default until WSK-40 lands: refuses, everywhere, production included. */
export const NOT_CONFIGURED_EDITORIAL_SIGNER: EditorialAssertionSigner = {
  configured: false,
  sign(): never {
    throw new EditorialSignerNotConfiguredError();
  },
};

let editorialSigner: EditorialAssertionSigner = NOT_CONFIGURED_EDITORIAL_SIGNER;
let clientOverride: WebdeskControlClient | null = null;

/** WSK-40 binds the real Ed25519 signer here at boot. */
export function registerEditorialAssertionSigner(signer: EditorialAssertionSigner): void {
  editorialSigner = signer;
}

/** Tests only: inject a control client (pointed at a stub Zone B) and a signer double. `null` resets. */
export function setWebdeskApprovedCommandDepsForTests(
  deps: { client?: WebdeskControlClient | null; signer?: EditorialAssertionSigner | null } | null,
): void {
  if (deps === null) {
    clientOverride = null;
    editorialSigner = NOT_CONFIGURED_EDITORIAL_SIGNER;
    return;
  }
  if (deps.client !== undefined) clientOverride = deps.client;
  if (deps.signer !== undefined) editorialSigner = deps.signer ?? NOT_CONFIGURED_EDITORIAL_SIGNER;
}

function controlClient(): WebdeskControlClient {
  return clientOverride ?? getWebdeskControlClient();
}

/** WSK-59: the registered signer, for the BFF's direct editorial writes. One seam, one registration
 *  (`registerEditorialAssertionSigner`), so approved commands and BFF writes can never sign differently. */
export function getEditorialAssertionSigner(): EditorialAssertionSigner {
  return editorialSigner;
}

/** WSK-59: the control client the approved-command executor uses (the process singleton, or a test
 *  double). Throws `WebdeskControlNotConfiguredError` when the channel is not configured. */
export function getWebdeskCommandControlClient(): WebdeskControlClient {
  return controlClient();
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Parsing (shared by filing and execution — the stored row is re-validated, never trusted)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_ITEMS = 1000;

/** Keys `fileWebdeskCommandApproval` writes itself; a caller's `args` may not carry them. */
const RESERVED_ARG_KEYS = ["command", "tenantSlug", "siteId", "itemId", "commandHash", "summary", "rebuild", "clientId"];
const ARG_KEYS: Record<WebdeskApprovedCommand, ReadonlyArray<string>> = {
  "content.publish": ["items", "note"],
  "content.schedule": ["items", "publishAt", "unpublishAt"],
  "key.mint": ["envId", "scope"],
  "content.rebuild": [],
};

class ArgsError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseItems(raw: unknown): WebdeskPublishItem[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ITEMS) {
    throw new ArgsError(`items must be an array of 1..${MAX_ITEMS} entries`);
  }
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (!isPlainObject(entry)) throw new ArgsError(`items[${i}] must be an object`);
    const extra = Object.keys(entry).filter((k) => !["itemId", "version", "contentHash"].includes(k));
    if (extra.length) throw new ArgsError(`items[${i}] has unknown keys: ${extra.join(", ")}`);
    const { itemId, version, contentHash } = entry;
    if (typeof itemId !== "string" || !UUID_RE.test(itemId)) throw new ArgsError(`items[${i}].itemId must be a uuid`);
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new ArgsError(`items[${i}].version must be a positive integer`);
    }
    if (contentHash !== undefined && (typeof contentHash !== "string" || !SHA256_RE.test(contentHash))) {
      throw new ArgsError(`items[${i}].contentHash must be a sha256 hex digest`);
    }
    const key = itemId.toLowerCase();
    if (seen.has(key)) throw new ArgsError(`items[${i}].itemId is duplicated`);
    seen.add(key);
    return contentHash === undefined ? { itemId, version } : { itemId, version, contentHash };
  });
}

function parseInstant(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) throw new ArgsError(`${field} must be an ISO-8601 instant or null`);
  return raw;
}

/** `raw` = `{command, tenantSlug, siteId, ...commandArgs}` (+ the stored-only keys on a stored row). */
function parseCommandArgs(raw: unknown): ParsedArgs {
  if (!isPlainObject(raw)) throw new ArgsError("tool_args must be an object");
  const { command, tenantSlug, siteId } = raw;
  if (!isApprovedCommand(command)) throw new ArgsError("command is not in the WebDesk approved-command allow-list");
  if (typeof tenantSlug !== "string" || !SLUG_RE.test(tenantSlug)) throw new ArgsError("tenantSlug must be a WebDesk tenant slug");
  if (typeof siteId !== "string" || !UUID_RE.test(siteId)) throw new ArgsError("siteId must be a uuid");
  switch (command) {
    case "content.publish": {
      const items = parseItems(raw.items);
      if (raw.publishAt !== undefined || raw.unpublishAt !== undefined) {
        throw new ArgsError("content.publish takes no publishAt/unpublishAt (that is content.schedule)");
      }
      if (raw.note !== undefined && (typeof raw.note !== "string" || raw.note.length > 500)) {
        throw new ArgsError("note must be a string of at most 500 characters");
      }
      return raw.note === undefined
        ? { command, tenantSlug, siteId, items }
        : { command, tenantSlug, siteId, items, note: raw.note as string };
    }
    case "content.schedule": {
      const items = parseItems(raw.items);
      const publishAt = parseInstant(raw.publishAt, "publishAt");
      const unpublishAt = parseInstant(raw.unpublishAt, "unpublishAt");
      if (publishAt === null && unpublishAt === null) throw new ArgsError("content.schedule needs publishAt or unpublishAt");
      return { command, tenantSlug, siteId, items, publishAt, unpublishAt };
    }
    case "key.mint": {
      if (typeof raw.envId !== "string" || !UUID_RE.test(raw.envId)) throw new ArgsError("envId must be a uuid");
      if (raw.scope !== "read" && raw.scope !== "write") throw new ArgsError("scope must be read|write");
      return { command, tenantSlug, siteId, envId: raw.envId, scope: raw.scope };
    }
    case "content.rebuild": {
      const extra = ["items", "note", "publishAt", "unpublishAt", "envId", "scope"].filter((k) => raw[k] !== undefined);
      if (extra.length) throw new ArgsError(`content.rebuild takes no ${extra.join(", ")}`);
      return { command, tenantSlug, siteId };
    }
  }
}

/** The exact Zone B request (design §3.1/§3.2; WebDesk keys.controller.ts for key.mint). Bodies never
 *  carry `tenantSlug`/`siteId`/`itemId` (design §3.2: a colliding key makes the hash ambiguous). */
function zoneBRequestFor(a: Exclude<ParsedArgs, { command: "content.rebuild" }>): ZoneBRequest {
  const wireItems = (items: WebdeskPublishItem[]) => items.map(({ itemId, version }) => ({ itemId, version }));
  switch (a.command) {
    case "content.publish":
      return {
        command: a.command,
        path: "/control/v1/tenants/:tenantSlug/sites/:siteId/content/publish",
        params: { tenantSlug: a.tenantSlug, siteId: a.siteId },
        body: a.note === undefined ? { items: wireItems(a.items) } : { items: wireItems(a.items), note: a.note },
      };
    case "content.schedule":
      return {
        command: a.command,
        path: "/control/v1/tenants/:tenantSlug/sites/:siteId/content/schedule",
        params: { tenantSlug: a.tenantSlug, siteId: a.siteId },
        body: { items: wireItems(a.items), publishAt: a.publishAt, unpublishAt: a.unpublishAt },
      };
    case "key.mint":
      return {
        command: a.command,
        path: "/control/v1/tenants/:tenantSlug/keys",
        params: { tenantSlug: a.tenantSlug },
        body: { envId: a.envId, scope: a.scope },
      };
  }
}

/** The hash Zone B will compute for this request (params ∪ JSON-round-tripped body). For `content.rebuild`,
 *  which sends nothing to Zone B, it is the same construction over its own (tenantSlug, siteId): the
 *  tamper check the executor makes before the dispatch, exactly as for key.mint. */
export function webdeskCommandHashFor(toolArgs: unknown): string {
  return commandHashOf(parseCommandArgs(toolArgs));
}

function commandHashOf(a: ParsedArgs): string {
  if (a.command === "content.rebuild") {
    return computeCommandHash(a.command, commandArgsAsZoneBSeesThem({ tenantSlug: a.tenantSlug, siteId: a.siteId }, {}));
  }
  const req = zoneBRequestFor(a);
  return computeCommandHash(req.command, commandArgsAsZoneBSeesThem(req.params, req.body));
}

function itemCountOf(a: ParsedArgs): number {
  return a.command === "key.mint" || a.command === "content.rebuild" ? 0 : a.items.length;
}

/** WSK-D46 R4: only a single-item, NON-scheduled publish may be approved by its own requester. A
 *  rebuild has no maker-checker arm (see the WSK-60 note in the header): its requester may decide it. */
function isSelfApprovable(a: ParsedArgs): boolean {
  return a.command === "content.rebuild" || (a.command === "content.publish" && a.items.length === 1);
}

function storedHashOf(toolArgs: unknown): string | null {
  const h = isPlainObject(toolArgs) ? toolArgs.commandHash : undefined;
  return typeof h === "string" && SHA256_RE.test(h) ? h : null;
}

/** Canonical equality of two JSON values (the same canonicalization the command hash uses). */
function sameJson(a: unknown, b: unknown): boolean {
  return computeCommandHash("eq", JSON.parse(JSON.stringify(a ?? null))) === computeCommandHash("eq", JSON.parse(JSON.stringify(b ?? null)));
}

function badRequest(token: string, message: string): BadRequestException {
  return new BadRequestException({ message: `${token}: ${message}`, reason: token });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Authorization
// ══════════════════════════════════════════════════════════════════════════════════════════════════

function filingGate(command: WebdeskApprovedCommand, tenantId: string): { resource: Resource; action: string } {
  return command === "key.mint"
    ? { resource: { kind: "webdev_provisioned_site", tenantId, module: "webdev" }, action: "promote" }
    : { resource: { kind: "webdesk_content_item", tenantId, module: "webdev" }, action: "request_publish" };
}

/** WSK-49c: the client a CLIENT editor decides for (the approval row's own `clientId`, verified by the caller). Absent for staff. */
export interface ClientDecider {
  clientId: string;
}

async function authorizeDecider(
  a: ParsedArgs,
  tenantId: string,
  approvalId: string,
  requestedBy: string,
  decider: Principal,
  client?: ClientDecider,
): Promise<void> {
  if (client && a.command !== "content.publish") {
    // D58 gives a client editor ONE decision: a content.publish. A schedule, a key mint and a rebuild are never theirs.
    throw new ForbiddenException(`not authorized: a client editor may decide only a publish, not ${a.command}`);
  }
  if (a.command === "content.rebuild") {
    // The dispatch's own D14 rule (`github_repo · deploy`, approvalId set, resolved against the ORG
    // tenant). Run here so a refusal at preflight leaves the row pending; workflow-dispatch.ts runs it
    // again at the send. A tenant that cannot resolve its org is a deployment fault (503), not a denial.
    try {
      await authorizeDeploy(decider, tenantId, approvalId);
    } catch (err) {
      if (err instanceof WorkflowDispatchError) {
        if (err.reason === "deploy_denied") throw new ForbiddenException(`not authorized: ${err.message}`);
        throw new ServiceUnavailableException({ message: `${WEBDESK_EXEC_ERROR.notConfigured}: ${err.message}`, reason: WEBDESK_EXEC_ERROR.notConfigured });
      }
      throw err;
    }
    return;
  }
  if (a.command === "key.mint") {
    // resource_webdev_provisioned_site.yaml's `promote` has no maker-checker arm and this ticket may
    // not edit it, so the rule is enforced here. A key mint is never self-approvable (R4 is publish-only).
    if (requestedBy && decider.userId === requestedBy) {
      throw new ForbiddenException("not authorized: a key mint may not be approved by the principal who requested it");
    }
    await authorize(decider, { kind: "webdev_provisioned_site", tenantId, module: "webdev", approvalId }, "promote");
    return;
  }
  await authorize(
    decider,
    {
      kind: "webdesk_content_item",
      tenantId,
      module: "webdev",
      approvalId,
      creatorId: requestedBy,
      // From the STORED row's items (the caller passes the row's tool_args), never from a request.
      itemCount: itemCountOf(a),
      // WSK-49c: the client editor's rule matches this against the principal's own grants (server-derived).
      ...(client ? { clientId: client.clientId } : {}),
    },
    a.command === "content.publish" ? "publish" : "schedule",
  );
}

function ensureConfigured(a: ParsedArgs): WebdeskControlClient | null {
  if (a.command === "content.rebuild") {
    // No Zone B send, no signer. What it needs is a configured staging target: without one the approval
    // could only fail, so refuse (503) at preflight and leave the row pending rather than approve a no-op.
    if (!rebuildTargetFor(a.tenantSlug, a.siteId)) {
      throw new ServiceUnavailableException({
        message: `${WEBDESK_EXEC_ERROR.notConfigured}: no staging rebuild target is configured for this site (WEBDESK_REBUILD_TARGETS)`,
        reason: WEBDESK_EXEC_ERROR.notConfigured,
      });
    }
    return null;
  }
  let client: WebdeskControlClient;
  try {
    client = controlClient();
  } catch (err) {
    if (err instanceof WebdeskControlNotConfiguredError) {
      throw new ServiceUnavailableException({ message: `${WEBDESK_EXEC_ERROR.notConfigured}: ${err.message}`, reason: WEBDESK_EXEC_ERROR.notConfigured });
    }
    throw err;
  }
  if (a.command !== "key.mint" && !editorialSigner.configured) {
    throw new ServiceUnavailableException({
      message: `${WEBDESK_EXEC_ERROR.notConfigured}: ${new EditorialSignerNotConfiguredError().message}`,
      reason: WEBDESK_EXEC_ERROR.notConfigured,
    });
  }
  return client;
}

/**
 * decide()'s gate, run BEFORE the decide UPDATE so a refusal leaves the row pending and Zone B
 * untouched: parse the stored args (400), authorize the decider against the command's own rule (403),
 * and require a configured channel + signer (503). Also phase 0 of the executor.
 */
export async function preflightWebdeskApprovedCommand(
  tenantId: string,
  approvalId: string,
  toolArgs: unknown,
  requestedBy: string,
  decider: Principal,
  clientDecider?: ClientDecider,
): Promise<{ args: ParsedArgs; client: WebdeskControlClient | null }> {
  if (!decider.userId) throw new BadRequestException("an authenticated decider is required");
  let a: ParsedArgs;
  try {
    a = parseCommandArgs(toolArgs);
  } catch (err) {
    if (err instanceof ArgsError) throw badRequest(WEBDESK_EXEC_ERROR.argsInvalid, err.message);
    throw err;
  }
  await authorizeDecider(a, tenantId, approvalId, requestedBy, decider, clientDecider);
  const client = ensureConfigured(a);
  return { args: a, client };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Filing
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * File ONE WS4 approval for a WebDesk HIGH command. `authorize()` runs FIRST — only the command name
 * (which picks the gate) is looked at before it — so validation never pre-empts authorization.
 * Called by WSK-59's `publish-requests` route and the M1 importer; nothing here sends to Zone B.
 */
export async function fileWebdeskCommandApproval(
  principal: Principal,
  tenantId: string,
  input: {
    command: WebdeskApprovedCommand;
    tenantSlug: string;
    siteId: string;
    args: Record<string, unknown>;
    summary: WebdeskApprovalSummary;
    /**
     * WSK-49c: set ONLY by the client-mode portal BFF. The approval is filed by a CLIENT editor for `clientId` (the
     * client the site -> client link names, loaded server-side). The filing is authorised under the client-editor
     * rules (`resource.attr.clientId`), and the row stores `clientId` in its `tool_args`, which is what lets another
     * client editor of the same client find and approve it (D58) and what a staff-filed request never carries. Only a
     * `content.publish` may be filed this way (a client never schedules or mints a key).
     * `notifyDeciders: false` skips the "approval requested" notification to staff (a self-publish needs no second person).
     */
    client?: { clientId: string; notifyDeciders?: boolean };
  },
): Promise<{ approvalId: string }> {
  if (!isApprovedCommand(input?.command)) {
    throw badRequest(WEBDESK_EXEC_ERROR.argsInvalid, "command is not in the WebDesk approved-command allow-list");
  }
  if (input.client && input.command !== "content.publish") {
    throw badRequest(WEBDESK_EXEC_ERROR.argsInvalid, "a client editor may file only a content.publish");
  }
  const gate = filingGate(input.command, tenantId);
  await authorize(principal, input.client ? { ...gate.resource, clientId: input.client.clientId } : gate.resource, gate.action);
  if (!principal.userId) throw new BadRequestException("an authenticated user is required");

  const args = isPlainObject(input.args) ? input.args : null;
  if (!args) throw badRequest(WEBDESK_EXEC_ERROR.argsInvalid, "args must be an object");
  const reserved = Object.keys(args).filter((k) => RESERVED_ARG_KEYS.includes(k));
  if (reserved.length) throw badRequest(WEBDESK_EXEC_ERROR.argsInvalid, `args may not carry ${reserved.join(", ")}`);
  const unknown = Object.keys(args).filter((k) => !ARG_KEYS[input.command].includes(k));
  if (unknown.length) throw badRequest(WEBDESK_EXEC_ERROR.argsInvalid, `unknown args for ${input.command}: ${unknown.join(", ")}`);

  const summary = input.summary;
  if (!isPlainObject(summary) || typeof summary.title !== "string" || summary.title.trim().length < 1 || summary.title.length > 300) {
    throw badRequest(WEBDESK_EXEC_ERROR.argsInvalid, "summary.title must be 1..300 characters");
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseCommandArgs({ command: input.command, tenantSlug: input.tenantSlug, siteId: input.siteId, ...args });
  } catch (err) {
    if (err instanceof ArgsError) throw badRequest(WEBDESK_EXEC_ERROR.argsInvalid, err.message);
    throw err;
  }

  const id = newId();
  const toolArgs: Record<string, unknown> = {
    ...parsed,
    // WSK-49c: server-set, never from a caller (RESERVED_ARG_KEYS): which client's editor filed this.
    ...(input.client ? { clientId: input.client.clientId } : {}),
    // WSK-D46 R3: one human decision covers the publish AND the staging rebuild. WSK-60 reads this.
    ...(parsed.command === "key.mint" ? {} : { rebuild: { target: "staging", approvalId: id } }),
    summary: {
      title: summary.title,
      ...(isPlainObject(summary.counts) ? { counts: summary.counts } : {}),
      ...(typeof summary.bundleSha256 === "string" ? { bundleSha256: summary.bundleSha256 } : {}),
    },
    // What the human approves, bound once. See the header: the editorial `cmh` carries THIS value.
    commandHash: commandHashOf(parsed),
  };

  const filing = {
    tenantId,
    workflowId: parsed.command,
    toolName: TOOL_NAME[parsed.command],
    toolArgs,
    impact: "high",
    reason: summary.title,
    origin: WEBDESK_APPROVAL_ORIGIN,
    requestedBy: principal.userId,
  };
  await withTenants([tenantId], (c) => insertAutomationApprovalRow(c, id, filing));

  await writeActivity(tenantId, principal.userId, "suspended", "automation_approval", id, {
    workflowId: filing.workflowId,
    toolName: filing.toolName,
    impact: "high",
    origin: WEBDESK_APPROVAL_ORIGIN,
    tenantSlug: parsed.tenantSlug,
    siteId: parsed.siteId,
    itemCount: itemCountOf(parsed),
    ...(input.client ? { clientEditor: true, clientId: input.client.clientId } : {}),
  });
  if (input.client?.notifyDeciders !== false) {
    const deciders = await resolveWebdeskApprovalDeciders(tenantId, {
      requestedBy: principal.userId,
      selfApprovalAllowed: isSelfApprovable(parsed),
    });
    await notifyBestEffort(tenantId, principal.userId, deciders, "approval.requested", {
      title: summary.title,
      href: `/approvals/${id}`,
      entityType: "automation_approval",
      entityId: id,
      origin: WEBDESK_APPROVAL_ORIGIN,
      impact: "high",
      tool: filing.toolName,
      severity: "warning",
    });
  }
  return { approvalId: id };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Execution
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const logger = new Logger("WebdeskApprovedCommand");

/** A typed token for an exception thrown before or around the claim. Never echoes a response body. */
function tokenFor(err: unknown): string {
  if (err instanceof ForbiddenException) return `${WEBDESK_EXEC_ERROR.denied}: ${err.message}`;
  if (err instanceof HttpException) {
    const r = err.getResponse() as { message?: unknown };
    return typeof r?.message === "string" ? r.message : err.message;
  }
  if (err instanceof EditorialSignerNotConfiguredError || err instanceof WebdeskControlNotConfiguredError) {
    return `${WEBDESK_EXEC_ERROR.notConfigured}: ${err.message}`;
  }
  return `${WEBDESK_EXEC_ERROR.argsInvalid}: ${(err as Error)?.message ?? "unknown"}`;
}

/** Problem `type` → its slug (RFC 9457, `…/errors/<slug>`). Slug-shaped or nothing: never body text. */
function problemSlugOf(res: WebdeskControlResponse): string {
  const j = isPlainObject(res.json) ? res.json : {};
  const candidates = [
    typeof j.type === "string" ? j.type.split("/").pop() : undefined,
    typeof j.error === "string" ? j.error : undefined,
    typeof j.code === "string" ? j.code : undefined,
  ];
  for (const c of candidates) if (typeof c === "string" && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(c)) return c;
  return "no-problem-type";
}

function capText(value: unknown): { text: string; truncated: boolean } {
  const text = JSON.stringify(value);
  return text.length > EXECUTION_RESULT_MAX_CHARS
    ? { text: text.slice(0, EXECUTION_RESULT_MAX_CHARS), truncated: true }
    : { text, truncated: false };
}

async function markFailedUnclaimed(tenantId: string, approvalId: string, error: string): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `UPDATE automation_approvals
          SET execution_status = 'failed', execution_error = $2, updated_at = now()
        WHERE id = $1 AND origin = 'webdesk' AND status = 'approved' AND execution_status = 'pending'
          AND deleted_at IS NULL`,
      [approvalId, error],
    ),
  );
}

async function finish(
  tenantId: string,
  approvalId: string,
  deciderId: string,
  outcome: { ok: true; result: Record<string, unknown> } | { ok: false; error: string },
): Promise<void> {
  await withTenants([tenantId], (c) =>
    outcome.ok
      ? c.query(
          `UPDATE automation_approvals
              SET execution_status = 'executed', executed_at = now(), executed_by = $2,
                  execution_result = $3::jsonb, execution_error = NULL, updated_at = now()
            WHERE id = $1 AND execution_status = 'executing'`,
          [approvalId, deciderId, JSON.stringify(capText(outcome.result))],
        )
      : c.query(
          `UPDATE automation_approvals
              SET execution_status = 'failed', executed_at = now(), executed_by = $2,
                  execution_error = $3, updated_at = now()
            WHERE id = $1 AND execution_status = 'executing'`,
          [approvalId, deciderId, outcome.error],
        ),
  );
}

function sameInstant(a: unknown, b: string | null): boolean {
  if (b === null) return a === null || a === undefined;
  return typeof a === "string" && Date.parse(a) === Date.parse(b);
}

/**
 * After an ambiguous failure: READ each item (WSK-51 `item.get`) and decide whether the requested
 * state holds. true = it does (executed); false = it does not; null = the state could not be read.
 * Reads only — a WS4 write is never resent.
 */
async function reconcileByReading(
  client: WebdeskControlClient,
  a: Extract<ParsedArgs, { command: "content.publish" | "content.schedule" }>,
): Promise<boolean | null> {
  for (const it of a.items) {
    let res: WebdeskControlResponse;
    try {
      res = await client.send({
        command: "item.get",
        method: "GET",
        path: "/control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId",
        params: { tenantSlug: a.tenantSlug, siteId: a.siteId, itemId: it.itemId },
      });
    } catch {
      return null;
    }
    if (res.status !== 200 || !isPlainObject(res.json) || !isPlainObject(res.json.item)) return null;
    const item = res.json.item;
    const holds =
      a.command === "content.publish"
        ? item.publishedVersion === it.version
        : sameInstant(item.publishAt, a.publishAt) && sameInstant(item.unpublishAt, a.unpublishAt);
    if (!holds) return false;
  }
  return true;
}

/**
 * Execute an APPROVED WebDesk command. Called from decide() right after the decide UPDATE flipped the
 * row to approved/pending, with that UPDATE's own RETURNING tool_args, and `requestedBy` = the row's
 * requested_by ("" when unknown, which fails closed in Cerbos).
 *
 * Throws (400/403/409/503) only BEFORE anything is sent — and then the row is `failed` (if it was
 * approved and pending) with a typed token. Every outcome after the send is returned as data and
 * recorded on the row; there is no path that sends twice.
 */
export async function executeApprovedWebdeskCommand(
  tenantId: string,
  approvalId: string,
  toolArgs: unknown,
  requestedBy: string,
  decider: Principal,
  clientDecider?: ClientDecider,
): Promise<WebdeskApprovedCommandResult> {
  // ── Phase 0: parse, authorize as the decider, check configuration. Nothing claimed, nothing sent.
  let pre: { args: ParsedArgs; client: WebdeskControlClient | null };
  try {
    pre = await preflightWebdeskApprovedCommand(tenantId, approvalId, toolArgs, requestedBy, decider, clientDecider);
  } catch (err) {
    await markFailedUnclaimed(tenantId, approvalId, tokenFor(err));
    throw err;
  }
  const a = pre.args;
  const deciderId = decider.userId as string;

  // ── Phase 1: CLAIM pending → executing. The WHERE clause is the single-use guarantee.
  const claim = await withTenants([tenantId], (c) =>
    c.query<{ workflow_id: string | null; tool_args: unknown; requested_by: string | null }>(
      `UPDATE automation_approvals
          SET execution_status = 'executing', execution_attempts = execution_attempts + 1, updated_at = now()
        WHERE id = $1 AND origin = 'webdesk' AND status = 'approved' AND execution_status = 'pending'
          AND deleted_at IS NULL
        RETURNING workflow_id, tool_args, requested_by`,
      [approvalId],
    ),
  );
  const row = claim.rows[0];
  if (!row) {
    throw new ConflictException({
      message: "webdesk_not_claimable: the approval is not approved-and-pending (already executed, failed, or not a webdesk row)",
      reason: "webdesk_not_claimable",
    });
  }
  // What was authorized must be what was claimed (no edit between preflight and claim).
  if (row.workflow_id !== a.command || !sameJson(row.tool_args, toolArgs) || (row.requested_by ?? "") !== (requestedBy ?? "")) {
    const error = `${WEBDESK_EXEC_ERROR.argsInvalid}: the approval row changed between authorization and claim`;
    await finish(tenantId, approvalId, deciderId, { ok: false, error });
    return { command: a.command, executionStatus: "failed", error };
  }

  const filedHash = storedHashOf(row.tool_args);
  if (!filedHash) {
    const error = `${WEBDESK_EXEC_ERROR.argsInvalid}: the approval carries no filed commandHash`;
    await finish(tenantId, approvalId, deciderId, { ok: false, error });
    return { command: a.command, executionStatus: "failed", error };
  }
  // ── WSK-60: a rebuild approval sends nothing to Zone B. Its whole effect is the dispatch.
  if (a.command === "content.rebuild") {
    return executeRebuildApproval({ tenantId, approvalId, a, toolArgs: row.tool_args, filedHash, requestedBy, decider, deciderId });
  }
  const zoneB = pre.client;
  if (!zoneB) {
    // Unreachable: preflight returns a client for every command that talks to Zone B.
    const error = `${WEBDESK_EXEC_ERROR.notConfigured}: no control client`;
    await finish(tenantId, approvalId, deciderId, { ok: false, error });
    return { command: a.command, executionStatus: "failed", error };
  }
  const req = zoneBRequestFor(a);
  if (a.command === "key.mint" && webdeskCommandHashFor(row.tool_args) !== filedHash) {
    // No editorial assertion travels with key.mint, so Zone B cannot see this; refuse here, unsent.
    const error = `${WEBDESK_EXEC_ERROR.argsTampered}: the stored args no longer match the filed command hash`;
    await finish(tenantId, approvalId, deciderId, { ok: false, error });
    return { command: a.command, executionStatus: "failed", error };
  }

  // ── Phase 2: the editorial assertion (content commands; WSK-40's signer).
  let editorialAssertion: string | undefined;
  if (a.command !== "key.mint") {
    try {
      editorialAssertion = await editorialSigner.sign({
        sub: deciderId,
        pk: decider.via?.agent ? "agent" : decider.via?.provider === "n8n" ? "automation" : "human",
        ...(decider.via?.agent ? { agt: decider.via.agent } : {}),
        ten: a.tenantSlug,
        site: a.siteId,
        cmd: a.command,
        cmh: filedHash,
        ...(requestedBy ? { req: requestedBy } : {}),
        apr: approvalId,
        // WSK-49c: a CLIENT decider's assertion carries the client marker, so WebDesk applies D59/D62 to what goes live.
        ...(clientDecider ? { ce: true as const } : {}),
      });
    } catch (err) {
      const error = err instanceof EditorialSignerNotConfiguredError
        ? `${WEBDESK_EXEC_ERROR.notConfigured}: ${err.message}`
        : `${WEBDESK_EXEC_ERROR.notConfigured}: the editorial signer failed (${(err as Error)?.name ?? "error"})`;
      await finish(tenantId, approvalId, deciderId, { ok: false, error });
      return { command: a.command, executionStatus: "failed", error };
    }
  }

  const selfPublish = !!requestedBy && requestedBy === deciderId;
  const activityBase = {
    viaApproval: approvalId,
    tenantSlug: a.tenantSlug,
    siteId: a.siteId,
    itemCount: itemCountOf(a),
    requestedBy: requestedBy || null,
    ...(a.command === "content.publish" ? { selfPublish } : {}),
    ...(clientDecider ? { clientEditor: true, clientId: clientDecider.clientId } : {}),
  };
  const verb = `webdesk.${a.command}`;
  // GH-04's two-row pattern: the ATTEMPT is on the ledger before the call, so a crash still leaves evidence.
  await writeActivity(tenantId, deciderId, verb, "automation_approval", approvalId, { ...activityBase, outcome: "attempted" });

  // ── Phase 3: exactly ONE send.
  let res: WebdeskControlResponse | null = null;
  let sendError: unknown = null;
  try {
    res = await zoneB.send({
      command: req.command,
      method: "POST",
      path: req.path,
      params: req.params,
      body: req.body,
      idempotencyKey: `ws4:${approvalId}`,
      ws4: { approvalId },
      ...(editorialAssertion !== undefined ? { editorialAssertion } : {}),
    });
  } catch (err) {
    sendError = err;
  }

  // ── Phase 4: classify. Never resend.
  let outcome: Exclude<WebdeskApprovedCommandResult, { command: "content.rebuild" }>;
  const ambiguous =
    (sendError instanceof WebdeskControlTransportError && sendError.maybeDelivered) || (res !== null && res.status >= 500);

  if (res !== null && res.status >= 200 && res.status < 300) {
    outcome = successOf(a, res, approvalId, selfPublish, false);
  } else if (ambiguous) {
    if (a.command === "key.mint") {
      outcome = {
        command: a.command,
        executionStatus: "failed",
        error: `${WEBDESK_EXEC_ERROR.ambiguous}: the mint may have committed and its answer was lost; revoke any key Zone B's audit shows under approval ${approvalId}`,
      };
    } else {
      const holds = await reconcileByReading(zoneB, a);
      outcome =
        holds === true
          ? successOf(a, null, approvalId, selfPublish, true)
          : {
              command: a.command,
              executionStatus: "failed",
              error:
                holds === false
                  ? `${WEBDESK_EXEC_ERROR.ambiguous}: the answer was lost and the items are NOT in the requested state; nothing was resent`
                  : `${WEBDESK_EXEC_ERROR.ambiguous}: the answer was lost and the item state could not be read; reconcile by hand, never resend`,
            };
    }
  } else if (res !== null) {
    outcome = { command: a.command, executionStatus: "failed", error: `${WEBDESK_EXEC_ERROR.refused}: ${res.status} ${problemSlugOf(res)}` };
  } else if (sendError instanceof EditorialUnavailableError) {
    outcome = { command: a.command, executionStatus: "failed", error: `${WEBDESK_EXEC_ERROR.unavailable}: circuit open, nothing sent` };
  } else if (sendError instanceof WebdeskControlTransportError) {
    outcome = {
      command: a.command,
      executionStatus: "failed",
      error: `${WEBDESK_EXEC_ERROR.unreachable}: ${sendError.transportCode ?? "transport"} after ${sendError.attempts} attempt(s), not delivered`,
    };
  } else if (sendError instanceof WebdeskControlTokenError) {
    outcome = { command: a.command, executionStatus: "failed", error: `${WEBDESK_EXEC_ERROR.unreachable}: control token unavailable, nothing sent` };
  } else if (sendError instanceof WebdeskControlNotConfiguredError) {
    outcome = { command: a.command, executionStatus: "failed", error: `${WEBDESK_EXEC_ERROR.notConfigured}: ${sendError.message}` };
  } else {
    // A programming error in the request shape (raised before any I/O by the client's own checks).
    outcome = { command: a.command, executionStatus: "failed", error: `${WEBDESK_EXEC_ERROR.argsInvalid}: ${(sendError as Error)?.message ?? "unknown"}` };
  }

  // ── Phase 5: record. execution_result NEVER holds the plaintext key.
  if (outcome.executionStatus === "executed") {
    const stored =
      outcome.command === "key.mint"
        ? { command: outcome.command, apiKeyId: outcome.apiKeyId, envId: outcome.envId, scope: outcome.scope }
        : { command: outcome.command, reconciled: outcome.reconciled, selfPublish: outcome.selfPublish, items: outcome.items, rebuild: outcome.rebuild };
    await finish(tenantId, approvalId, deciderId, { ok: true, result: stored });
    await writeActivity(tenantId, deciderId, verb, "automation_approval", approvalId, {
      ...activityBase,
      outcome: outcome.command !== "key.mint" && outcome.reconciled ? "reconciled" : "succeeded",
      ...(outcome.command === "key.mint" ? { apiKeyId: outcome.apiKeyId } : {}),
    });
  } else {
    await finish(tenantId, approvalId, deciderId, { ok: false, error: outcome.error });
    await writeActivity(tenantId, deciderId, verb, "automation_approval", approvalId, {
      ...activityBase,
      outcome: "failed",
      error: outcome.error,
    });
  }
  logger.log(`approval ${approvalId} ${a.command}: ${outcome.executionStatus}${outcome.executionStatus === "failed" ? ` (${outcome.error.split(":")[0]})` : ""}`);

  // ── WSK-60 (R3): ONE call to start the staging rebuild after a successful PUBLISH. The call never
  // throws, and a rebuild that could not start does not touch the publish: the row above is already
  // `executed`. (A schedule publishes nothing yet, so it rebuilds nothing.)
  if (outcome.executionStatus === "executed" && outcome.command === "content.publish" && a.command === "content.publish") {
    outcome = { ...outcome, build: await startRebuildAfterPublish(tenantId, approvalId, a, outcome.items, decider) };
  }

  // The requester is the one waiting (design §6: "requester notified").
  // WSK-49c: NOT for a client decision. The notification's href is the staff inbox (`/approvals/<id>`), which a client
  // contact cannot open, and the portal page that would carry it (`/portal/website`) is WSK-49d's: a link to it now would
  // dangle (portal-links.guard.test.ts). The client's own request list is the read for "did it go live" until then.
  if (requestedBy && requestedBy !== deciderId && !clientDecider) {
    const ok = outcome.executionStatus === "executed";
    await notifyBestEffort(tenantId, deciderId, [requestedBy], ok ? "automation_approval.executed" : "automation_approval.execution_failed", {
      title: ok ? `WebDesk ${a.command} executed` : `WebDesk ${a.command} FAILED to execute`,
      body: ok ? undefined : (outcome as { error: string }).error,
      href: `/approvals/${approvalId}`,
      entityType: "automation_approval",
      entityId: approvalId,
      severity: ok ? "info" : "warning",
      origin: WEBDESK_APPROVAL_ORIGIN,
      tool: TOOL_NAME[a.command],
    });
  }
  return outcome;
}

type PublishArgs = Extract<ParsedArgs, { command: "content.publish" }>;

/** The newest `publishedAt` Zone B reported for this publish, or null when it reported none (a
 *  reconciled outcome, or an older Zone B). Compared as instants, returned as the original string. */
function newestPublishedAt(items: Array<{ publishedAt?: string | null }>): string | null {
  let best: string | null = null;
  let bestT = -Infinity;
  for (const it of items) {
    const t = it.publishedAt ? Date.parse(it.publishedAt) : NaN;
    if (Number.isFinite(t) && t > bestT) {
      bestT = t;
      best = it.publishedAt as string;
    }
  }
  return best;
}

async function startRebuildAfterPublish(
  tenantId: string,
  approvalId: string,
  a: PublishArgs,
  items: Array<{ publishedAt?: string | null }>,
  decider: Principal,
): Promise<{ buildId: string | null; state: "rebuilding" | "live" | "unverified" | "failed"; failureReason: string | null }> {
  const r = await startSiteRebuild({
    tenantId,
    tenantSlug: a.tenantSlug,
    siteId: a.siteId,
    approvalId,
    kind: "publish",
    publishedAt: newestPublishedAt(items),
    decider,
  });
  return { buildId: r.buildId, state: r.state, failureReason: r.failureReason };
}

/** A `content.rebuild` approval: tamper check, then ONE dispatch. Executed = the dispatch was accepted;
 *  failed = it was not, with `webdesk_rebuild_failed: <typed reason>` on the row. */
async function executeRebuildApproval(p: {
  tenantId: string;
  approvalId: string;
  a: Extract<ParsedArgs, { command: "content.rebuild" }>;
  toolArgs: unknown;
  filedHash: string;
  requestedBy: string;
  decider: Principal;
  deciderId: string;
}): Promise<WebdeskApprovedCommandResult> {
  const { tenantId, approvalId, a, deciderId } = p;
  const fail = async (error: string): Promise<WebdeskApprovedCommandResult> => {
    await finish(tenantId, approvalId, deciderId, { ok: false, error });
    await writeActivity(tenantId, deciderId, "webdesk.content.rebuild", "automation_approval", approvalId, {
      viaApproval: approvalId, tenantSlug: a.tenantSlug, siteId: a.siteId, requestedBy: p.requestedBy || null, outcome: "failed", error,
    });
    return { command: a.command, executionStatus: "failed", error };
  };
  if (webdeskCommandHashFor(p.toolArgs) !== p.filedHash) {
    return fail(`${WEBDESK_EXEC_ERROR.argsTampered}: the stored args no longer match the filed command hash`);
  }
  const base = { viaApproval: approvalId, tenantSlug: a.tenantSlug, siteId: a.siteId, requestedBy: p.requestedBy || null };
  await writeActivity(tenantId, deciderId, "webdesk.content.rebuild", "automation_approval", approvalId, { ...base, outcome: "attempted" });

  const r = await startSiteRebuild({
    tenantId, tenantSlug: a.tenantSlug, siteId: a.siteId, approvalId, kind: "rebuild", publishedAt: null, decider: p.decider,
  });
  let result: WebdeskApprovedCommandResult;
  if (r.state === "failed") {
    result = await fail(`${WEBDESK_EXEC_ERROR.rebuildFailed}: ${r.failureReason ?? "unknown"}`);
  } else {
    const stored = { command: a.command, rebuild: { target: "staging" as const, approvalId }, build: { buildId: r.buildId, state: r.state } };
    await finish(tenantId, approvalId, deciderId, { ok: true, result: stored });
    await writeActivity(tenantId, deciderId, "webdesk.content.rebuild", "automation_approval", approvalId, { ...base, outcome: "succeeded", buildId: r.buildId });
    result = { command: a.command, executionStatus: "executed", rebuild: { target: "staging", approvalId }, build: { buildId: r.buildId, state: r.state, failureReason: null } };
  }
  logger.log(`approval ${approvalId} content.rebuild: ${result.executionStatus}${result.executionStatus === "failed" ? ` (${result.error.split(":")[0]})` : ""}`);
  if (p.requestedBy && p.requestedBy !== deciderId) {
    const ok = result.executionStatus === "executed";
    await notifyBestEffort(tenantId, deciderId, [p.requestedBy], ok ? "automation_approval.executed" : "automation_approval.execution_failed", {
      title: ok ? "Staging rebuild started" : "Staging rebuild FAILED to start",
      body: ok ? undefined : (result as { error: string }).error,
      href: `/approvals/${approvalId}`,
      entityType: "automation_approval",
      entityId: approvalId,
      severity: ok ? "info" : "warning",
      origin: WEBDESK_APPROVAL_ORIGIN,
      tool: TOOL_NAME[a.command],
    });
  }
  return result;
}

function successOf(
  a: Exclude<ParsedArgs, { command: "content.rebuild" }>,
  res: WebdeskControlResponse | null,
  approvalId: string,
  selfPublish: boolean,
  reconciled: boolean,
): Exclude<WebdeskApprovedCommandResult, { command: "content.rebuild" }> {
  const j = res && isPlainObject(res.json) ? res.json : {};
  if (a.command === "key.mint") {
    return {
      command: a.command,
      executionStatus: "executed",
      apiKeyId: typeof j.id === "string" ? j.id : null,
      envId: a.envId,
      scope: a.scope,
      plaintextOnce: typeof j.key === "string" ? j.key : null,
    };
  }
  const reported = Array.isArray(j.published) ? j.published : Array.isArray(j.scheduled) ? j.scheduled : [];
  const publishedAtOf = (itemId: string): string | null => {
    const hit = reported.find((p): p is Record<string, unknown> => isPlainObject(p) && p.itemId === itemId);
    return hit && typeof hit.publishedAt === "string" ? hit.publishedAt : null;
  };
  return {
    command: a.command,
    executionStatus: "executed",
    reconciled,
    selfPublish: a.command === "content.publish" && selfPublish,
    items: a.items.map((it) => ({ itemId: it.itemId, version: it.version, publishedAt: publishedAtOf(it.itemId) })),
    rebuild: { target: "staging", approvalId },
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WSK-49c — a CLIENT editor decides a client's publish (WSK-D58)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// The staff path is `decide()` in automation-approvals.controller.ts, behind the generic `decide` gate (company_admin).
// A client editor is not, and must not become, an approval decider in general: D58 gives them ONE decision, a
// `content.publish` that a client editor of their own client filed through the portal BFF, and only on these terms:
//   * single item they requested -> they may approve it themselves (R4's client analogue);
//   * a batch -> a DIFFERENT person (maker != checker), who also holds the grant for the SAME client.
// Both are decided by Cerbos (`webdesk_content_item` . `publish`, the client-editor rule + the roles:[user] DENYs, with
// `clientId` from the row) inside the SAME preflight the staff path uses, so there is no second copy of the rule here.
//
// ORDER (a refusal at any step before the UPDATE leaves the row `pending` and sends nothing to WebDesk):
//   1. load the row in the request's tenant (RLS). Not a WebDesk content.publish row, not filed for THIS client, or not
//      found -> the SAME 404 (no existence oracle across clients or companies);
//   2. `beforeDecide` (the portal service): the site is still linked to this client, and the D62 pre-check passes;
//   3. preflight: Cerbos as the decider with the row's creator and itemCount, channel and signer configured (403/503);
//   4. the decide UPDATE (status pending -> approved, execution pending) + the `automation_approval.decided` event: the
//      single-use guard, exactly as decide() does it;
//   5. the in-band executor, as the decider, signing with `ce: true`.
export async function approveClientWebdeskPublish(input: {
  tenantId: string;
  approvalId: string;
  decider: Principal;
  clientId: string;
  beforeDecide: (row: { tenantSlug: string; siteId: string; items: WebdeskPublishItem[]; requestedBy: string }) => Promise<void>;
}): Promise<{ id: string; status: "approved"; webdesk: WebdeskApprovedCommandResult }> {
  const { tenantId, approvalId, decider, clientId } = input;
  const notFound = (): HttpException => new NotFoundException("approval not found");
  if (!UUID_RE.test(approvalId)) throw notFound();
  if (!decider.userId) throw new BadRequestException("an authenticated decider is required");

  const found = await withTenants([tenantId], (c) =>
    c.query<{ origin: string; workflow_id: string; status: string; requested_by: string | null; tool_args: unknown }>(
      `SELECT origin, workflow_id, status, requested_by, tool_args FROM automation_approvals WHERE id = $1 AND deleted_at IS NULL`,
      [approvalId],
    ),
  );
  const row = found.rows[0];
  const stored = row && isPlainObject(row.tool_args) ? row.tool_args : null;
  if (!row || !stored || row.origin !== WEBDESK_APPROVAL_ORIGIN || row.workflow_id !== "content.publish" || stored.clientId !== clientId) {
    throw notFound();
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseCommandArgs(stored);
  } catch (err) {
    if (err instanceof ArgsError) throw badRequest(WEBDESK_EXEC_ERROR.argsInvalid, err.message);
    throw err;
  }
  if (parsed.command !== "content.publish") throw notFound();
  if (row.status !== "pending") {
    throw new ConflictException({ message: "approval_not_pending: this request has already been decided or withdrawn", reason: "approval_not_pending" });
  }
  const requestedBy = row.requested_by ?? "";

  await input.beforeDecide({ tenantSlug: parsed.tenantSlug, siteId: parsed.siteId, items: parsed.items, requestedBy });
  await preflightWebdeskApprovedCommand(tenantId, approvalId, row.tool_args, requestedBy, decider, { clientId });

  const decided = await withTenants([tenantId], async (c) => {
    const upd = await c.query<{ origin: string; tool_args: unknown; workflow_id: string; tool_name: string }>(
      `UPDATE automation_approvals
          SET status = 'approved', decided_by = $2, decided_at = now(), updated_at = now(), execution_status = 'pending'
        WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL
        RETURNING origin, tool_args, workflow_id, tool_name`,
      [approvalId, decider.userId],
    );
    if (upd.rowCount === 0) return null;
    await emitEvent(c, tenantId, "automation_approval", approvalId, "automation_approval.decided", {
      decision: "approved",
      origin: upd.rows[0].origin,
      toolArgs: upd.rows[0].tool_args,
      workflowId: upd.rows[0].workflow_id,
      toolName: upd.rows[0].tool_name,
      decidedBy: decider.userId,
    });
    return upd.rows[0];
  });
  if (!decided) {
    throw new ConflictException({ message: "approval_not_pending: this request has already been decided or withdrawn", reason: "approval_not_pending" });
  }
  const webdesk = await executeApprovedWebdeskCommand(tenantId, approvalId, decided.tool_args, requestedBy, decider, { clientId });
  await writeActivity(tenantId, decider.userId, "approved", "automation_approval", approvalId, { origin: WEBDESK_APPROVAL_ORIGIN, clientEditor: true, clientId });
  return { id: approvalId, status: "approved", webdesk };
}
