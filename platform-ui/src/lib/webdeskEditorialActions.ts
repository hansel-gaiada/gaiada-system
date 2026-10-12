"use server";
// M5-W2e — the writers' room's writes (and the panel's client-driven re-read). Same shape as `webdeskContentActions.ts`: a `ctx()`
// resolving session -> me -> active company, then a typed `WdResult`. There is NO `can(me, …)` gate: what a caller may do comes from
// the item's `allowed` (the BFF's Cerbos answer) and the BFF checks every command again BEFORE it validates the body, so a denial is
// a 403 for any body. A refusal comes back as DATA (never thrown) so the panel can say it in words and keep what the user typed.
//
//   POST …/sites/:t/:s/items/:itemId/editorial/submit            {version}                    -> 200 {itemId, editorial, replayed}
//   POST …/editorial/withdraw                                    {}                            -> 200
//   POST …/editorial/request-changes                             {version, note (1..2000)}     -> 200
//   POST …/editorial/seo-signoff                                 {version}                     -> 200
//   POST …/editorial/approve                                     {version}                     -> 200   (maker != checker is the server's call)
//   POST …/editorial/assign                                      {authorSub?, dueAt?, plannedPublishAt?, briefRef?} (at least one)
//   POST …/editorial/comments                                    {version, body (1..4000), anchor?}  -> 201
//   POST …/editorial/comments/:commentId/resolve                 {}                            -> 200
//   GET|POST …/sites/:t/:s/editorial/grants, DELETE …/editorial/grants/:userId/:role           (M5-W1b, publisher tier)
//
// `idempotencyKey` is optional and comes from the browser: one key per user intent, reused when the same intent is retried, so a
// retry after a lost answer cannot add a second comment. The BFF generates one when it is absent.
import { getSessionUserId } from "./session-server";
import { getMe } from "./platform";
import { getActiveTenant } from "./tenant";
import { siteBase, wdCall, wire } from "./webdeskContent";
import type { WdResult } from "./webdeskContentModel";
import { listEditorialGrants, loadEditorialState } from "./webdeskEditorial";
import type { EditorialState, GrantInput, GrantsBody, GrantWritten } from "./webdeskEditorialModel";
import { isEditorialRole } from "./webdeskEditorialModel";

export interface EditorialScope { tenantSlug: string; siteId: string }
type Ctx = { userId: string; company: string };

async function ctx(): Promise<Ctx | WdResult<never>> {
  const userId = await getSessionUserId();
  if (!userId) return { kind: "unavailable", code: "upstream_error", reason: "session_expired" };
  const me = await getMe(userId);
  const company = await getActiveTenant(me);
  if (!company) return { kind: "unavailable", code: "upstream_error", reason: "no_active_company" };
  return { userId, company };
}
const isCtx = (c: Ctx | WdResult<never>): c is Ctx => "userId" in c;

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");
const scopeOk = (s: EditorialScope): boolean => !!clean(s?.tenantSlug) && !!clean(s?.siteId);
const badScope: WdResult<never> = { kind: "invalid", issues: [], message: "Missing site." };
const badInput = (message: string): WdResult<never> => ({ kind: "invalid", issues: [], message });

const IDEM_RE = /^[\x21-\x7e]{8,200}$/;
function post(body: unknown, idempotencyKey?: string): RequestInit {
  return {
    method: "POST",
    body: JSON.stringify(body),
    ...(idempotencyKey && IDEM_RE.test(idempotencyKey) ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
  };
}

const itemPath = (c: Ctx, scope: EditorialScope, itemId: string) => `${siteBase(c.company, scope.tenantSlug, scope.siteId)}/items/${encodeURIComponent(itemId)}/editorial`;

/** What a command answers. Validated, and small on purpose: the panel re-reads the state instead of trusting a write's echo. */
export interface EditorialAck { replayed: boolean; commentId: string | null }
function parseAck(v: unknown): EditorialAck {
  const o = wire.obj(v, "editorial");
  wire.opt(o, "itemId", wire.str, "editorial");
  return { replayed: wire.opt(o, "replayed", wire.bool, "editorial") === true, commentId: wire.opt(o, "commentId", wire.str, "editorial") ?? null };
}

const versionOk = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;

// ── The panel's re-read ──────────────────────────────────────────────────────────────────────────

/** The item head's `editorial` + `allowed` and its review record, in one result (see `loadEditorialState`). */
export async function loadEditorialStateAction(scope: EditorialScope, itemId: string): Promise<WdResult<EditorialState>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId)) return badScope;
  return loadEditorialState(c.userId, c.company, scope.tenantSlug, scope.siteId, itemId);
}

// ── Item commands ────────────────────────────────────────────────────────────────────────────────

export async function submitForReviewAction(scope: EditorialScope, itemId: string, version: number, idempotencyKey?: string): Promise<WdResult<EditorialAck>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId)) return badScope;
  if (!versionOk(version)) return badInput("Missing version.");
  return wdCall(`${itemPath(c, scope, itemId)}/submit`, c.userId, parseAck, post({ version }, idempotencyKey));
}

export async function withdrawFromReviewAction(scope: EditorialScope, itemId: string, idempotencyKey?: string): Promise<WdResult<EditorialAck>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId)) return badScope;
  return wdCall(`${itemPath(c, scope, itemId)}/withdraw`, c.userId, parseAck, post({}, idempotencyKey));
}

export async function requestChangesAction(scope: EditorialScope, itemId: string, version: number, note: string, idempotencyKey?: string): Promise<WdResult<EditorialAck>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId)) return badScope;
  if (!versionOk(version)) return badInput("Missing version.");
  const n = clean(note);
  if (n.length < 1 || n.length > 2000) return badInput("Say what needs to change, in 1 to 2000 characters.");
  return wdCall(`${itemPath(c, scope, itemId)}/request-changes`, c.userId, parseAck, post({ version, note: n }, idempotencyKey));
}

export async function seoSignoffAction(scope: EditorialScope, itemId: string, version: number, idempotencyKey?: string): Promise<WdResult<EditorialAck>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId)) return badScope;
  if (!versionOk(version)) return badInput("Missing version.");
  return wdCall(`${itemPath(c, scope, itemId)}/seo-signoff`, c.userId, parseAck, post({ version }, idempotencyKey));
}

export async function approveAction(scope: EditorialScope, itemId: string, version: number, idempotencyKey?: string): Promise<WdResult<EditorialAck>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId)) return badScope;
  if (!versionOk(version)) return badInput("Missing version.");
  return wdCall(`${itemPath(c, scope, itemId)}/approve`, c.userId, parseAck, post({ version }, idempotencyKey));
}

export interface AssignInput {
  authorSub?: string;
  /** ISO instants; null clears. Absent = unchanged. */
  dueAt?: string | null;
  plannedPublishAt?: string | null;
  briefRef?: string | null;
}

export async function assignAction(scope: EditorialScope, itemId: string, input: AssignInput, idempotencyKey?: string): Promise<WdResult<EditorialAck>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId)) return badScope;
  const body: Record<string, unknown> = {};
  if (clean(input?.authorSub)) body.authorSub = clean(input.authorSub);
  for (const k of ["dueAt", "plannedPublishAt"] as const) {
    const v = input?.[k];
    if (v === null) body[k] = null;
    else if (typeof v === "string" && v !== "") {
      if (Number.isNaN(Date.parse(v))) return badInput("That date isn't valid.");
      body[k] = v;
    }
  }
  if (input?.briefRef === null) body.briefRef = null;
  else if (clean(input?.briefRef)) body.briefRef = clean(input.briefRef);
  if (Object.keys(body).length === 0) return badInput("Change at least one of the assignee, the dates or the brief.");
  return wdCall(`${itemPath(c, scope, itemId)}/assign`, c.userId, parseAck, post(body, idempotencyKey));
}

export async function addCommentAction(scope: EditorialScope, itemId: string, version: number, text: string, anchor?: string, idempotencyKey?: string): Promise<WdResult<EditorialAck>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId)) return badScope;
  if (!versionOk(version)) return badInput("Missing version.");
  const body = clean(text);
  if (body.length < 1 || body.length > 4000) return badInput("Write the comment, in 1 to 4000 characters.");
  if (anchor !== undefined && (anchor.length > 512 || !(anchor === "" || anchor.startsWith("/")))) return badInput("The field reference must start with / (for example /blocks/0/props/h1).");
  return wdCall(`${itemPath(c, scope, itemId)}/comments`, c.userId, parseAck, post({ version, body, ...(anchor !== undefined ? { anchor } : {}) }, idempotencyKey));
}

export async function resolveCommentAction(scope: EditorialScope, itemId: string, commentId: string, idempotencyKey?: string): Promise<WdResult<EditorialAck>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId) || !clean(commentId)) return badScope;
  return wdCall(`${itemPath(c, scope, itemId)}/comments/${encodeURIComponent(commentId)}/resolve`, c.userId, parseAck, post({}, idempotencyKey));
}

// ── Grants (publisher tier) ──────────────────────────────────────────────────────────────────────

const grantsPath = (c: Ctx, scope: EditorialScope) => `${siteBase(c.company, scope.tenantSlug, scope.siteId)}/editorial/grants`;

function parseGrantWritten(v: unknown): GrantWritten {
  const o = wire.obj(v, "grant");
  return {
    userId: wire.key(o, "userId", wire.str, "grant"), role: wire.key(o, "role", wire.str, "grant"), changed: wire.key(o, "changed", wire.bool, "grant"),
    ...(wire.opt(o, "createdGrant", wire.bool, "grant") !== undefined ? { createdGrant: wire.opt(o, "createdGrant", wire.bool, "grant") } : {}),
    ...(wire.opt(o, "removedGrant", wire.bool, "grant") !== undefined ? { removedGrant: wire.opt(o, "removedGrant", wire.bool, "grant") } : {}),
  };
}

/** Re-read the grants list (the manager's refresh after a write). A 403 here is the page's "you can't manage writers here". */
export async function listGrantsAction(scope: EditorialScope): Promise<WdResult<GrantsBody>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  return listEditorialGrants(c.userId, c.company, scope.tenantSlug, scope.siteId);
}

export async function grantRoleAction(scope: EditorialScope, input: GrantInput): Promise<WdResult<GrantWritten>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  if (!clean(input?.userId) || !isEditorialRole(String(input?.role))) return badInput("Choose a person and a role.");
  if (!input.allCollections && input.collections.length === 0) return badInput("Choose at least one collection, or every collection.");
  if (!input.allLocales && input.locales.length === 0) return badInput("Choose at least one language, or every language.");
  if (input.expiresAt !== null && Number.isNaN(Date.parse(input.expiresAt))) return badInput("That expiry date isn't valid.");
  // An empty list never means "all" to the BFF: send exactly one of each pair.
  const body = {
    userId: clean(input.userId), role: input.role,
    ...(input.allCollections ? { allCollections: true } : { collections: input.collections }),
    ...(input.allLocales ? { allLocales: true } : { locales: input.locales }),
    expiresAt: input.expiresAt,
  };
  return wdCall(grantsPath(c, scope), c.userId, parseGrantWritten, post(body));
}

export async function revokeRoleAction(scope: EditorialScope, userId: string, role: string): Promise<WdResult<GrantWritten>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(userId)) return badScope;
  if (!isEditorialRole(role)) return badInput("Choose a role.");
  return wdCall(`${grantsPath(c, scope)}/${encodeURIComponent(clean(userId))}/${encodeURIComponent(role)}`, c.userId,
    (v) => {
      const o = wire.obj(v, "revoke");
      return { userId: wire.key(o, "userId", wire.str, "revoke"), role: wire.key(o, "role", wire.str, "revoke"), changed: wire.key(o, "changed", wire.bool, "revoke"), removedGrant: wire.key(o, "removedGrant", wire.bool, "revoke") };
    },
    { method: "DELETE" });
}
