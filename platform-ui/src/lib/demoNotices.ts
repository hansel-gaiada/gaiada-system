import "server-only";
// TEMP DEMO MODE: stateful in-memory store for the department notice board (DW-10a-2, BFF §57), after `demoDeptKpis.ts` (the same people,
// the same placement). Routed from `demoFixtures.getDemoResponse`, so the notices pages, the Overview's Notices blocks and the Inbox work with
// no backend. Module-level state lasts for the dev-server process; `resetNoticesDemo()` is for tests.
//
// It models the rules the UI depends on, in the server's order of checks: reads (a person placed in the unit, its head, or the company-wide tiers
// read a unit's notices; every staff person reads the company-wide ones; a client contact reads nothing: 403; an unreadable named notice is
// 404, never 403), the unit gate on a list (403 `outside your reporting line` BEFORE any word on whether the unit exists, then 404), writes
// (AUTHORIZATION BEFORE VALIDATION: a refused caller always gets 403, never 400; a company-wide notice is the company admin's alone; a head
// writes to their own unit), `canEdit`, the 3-pin limit (409 `pin_limit`), withdrawal (a withdrawn notice is in no list and 404s), and the
// current/past split by end date. It sends no notifications (the Inbox is not part of this store).
//
// WHO (as `demoDeptKpis.ts`): `demo-hansel` is the company admin and company-wide; `demo-owner` reads everything but posts nothing (the owner
// has no write mirror, PERMISSION §47); `u-webhead` leads `dept-1` (Web Dev); `dept-manager` leads `dept-3` (SEO); `u-dev`, `seo-staff`, `u-seo`,
// `u-social` and `u-creative` are staff placed in their own department. The demo company is `co-agency`; any other company has no notices.
// THE UNITS are `defaultStructure`'s agency tree: dept-1 Web Dev, dept-2 Creatives, dept-3 SEO, dept-4 Social Media, dept-5 GM and, since DW-7d,
// dept-6 HR, dept-7 Finance and dept-8 IT (the root is "root", and a unit id on the root is 404, as the server has it). `u-hr` (`hr_staff`) reads
// every unit's notices as the HR tier does; the finance and IT logins are unplaced in the demo, so they read the company-wide ones only.
import { todayIsoInDisplayZone } from "./format";

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const err = (status: number, error: string, field?: string): DemoResult => ({ status, json: field ? { error, field } : { error } });

const TENANT = "co-agency";
const UNITS: Record<string, string> = {
  "dept-1": "Web Dev", "dept-2": "Creatives", "dept-3": "SEO", "dept-4": "Social Media", "dept-5": "GM", "dept-6": "HR", "dept-7": "Finance", "dept-8": "IT",
};
const ROOT = "root";

const ADMINS = new Set(["demo-hansel"]);
/** Who reads every unit's notices (PERMISSION §47: the company-wide tiers; the HR staff tier is one, `isCompanyWide`). Only the admin writes. */
const COMPANY_WIDE = new Set(["demo-hansel", "demo-owner", "u-hr"]);
const LED: Record<string, string[]> = { "u-webhead": ["dept-1"], "dept-manager": ["dept-3"] };
const PLACED: Record<string, string[]> = {
  "u-dev": ["dept-1"], "u-pm": ["dept-1"], "seo-staff": ["dept-3"], "u-seo": ["dept-3"], "u-social": ["dept-4"], "u-creative": ["dept-2"],
};
/** External client contacts are not staff: the notice board is the company's own (PERMISSION §47: never a client contact). */
const isClientContact = (userId: string) => userId.startsWith("demo-client") || userId === "demo-two-company-client" || userId === "demo-viceroy-marketing";
const NAMES: Record<string, string> = { "demo-hansel": "Clement Hansel", "u-webhead": "Ketut Arta", "dept-manager": "Wayan Sari" };

const TITLE_MAX = 120;
const BODY_MAX = 4000;
const PIN_MAX = 3;
const LIST_MAX = 50;
const LIST_DEFAULT = 20;

interface DemoNotice {
  id: string; tenantId: string; scope: "unit" | "company"; unitNodeId: string | null; title: string; body: string; pinned: boolean; endsOn: string | null;
  authorId: string; createdAt: string; editedAt: string | null; withdrawnAt: string | null; seq: number;
}

let seq = 0;
const nid = () => `00000000-0000-4000-8000-${String(900000 + ++seq).padStart(12, "0")}`;
const today = () => todayIsoInDisplayZone();
const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;

function seed(): DemoNotice[] {
  const mk = (n: Omit<DemoNotice, "id" | "tenantId" | "editedAt" | "withdrawnAt" | "seq">): DemoNotice => ({ id: nid(), tenantId: TENANT, editedAt: null, withdrawnAt: null, seq: seq, ...n });
  return [
    mk({ scope: "unit", unitNodeId: "dept-1", pinned: true, authorId: "u-webhead", createdAt: ago(3 * HOUR), endsOn: addDay(today(), 7),
      title: "Release freeze starts Friday 17:00",
      body: "Nothing ships to a client site from Friday 17:00 until Monday 09:00.\nUrgent fixes go through the head of Web Dev.\n\nPlease close your open pull requests before the freeze." }),
    mk({ scope: "unit", unitNodeId: "dept-1", pinned: false, authorId: "u-webhead", createdAt: ago(50 * HOUR), endsOn: null,
      title: "New code-review checklist",
      body: "The checklist is in the shared drive under Web Dev > Standards. It applies to every pull request from this week." }),
    mk({ scope: "company", unitNodeId: null, pinned: false, authorId: "demo-hansel", createdAt: ago(26 * HOUR), endsOn: addDay(today(), 14),
      title: "Office closed for Nyepi",
      body: "The office is closed for Nyepi.\nThe on-call rota for client sites stays as published." }),
    // A past notice, so the Past view can be driven: it ended yesterday.
    mk({ scope: "unit", unitNodeId: "dept-1", pinned: false, authorId: "u-webhead", createdAt: ago(12 * 24 * HOUR), endsOn: addDay(today(), -1),
      title: "Quarter retro notes", body: "The notes from the quarter retrospective are in the team wiki." }),
  ];
}
let notices: DemoNotice[] = seed();

/** For tests. */
export function resetNoticesDemo(): void { seq = 0; notices = seed(); }

const mayReadUnit = (userId: string, unit: string): boolean =>
  COMPANY_WIDE.has(userId) || (LED[userId] ?? []).includes(unit) || (PLACED[userId] ?? []).includes(unit);
const mayWrite = (userId: string, n: Pick<DemoNotice, "scope" | "unitNodeId">): boolean =>
  ADMINS.has(userId) || (n.scope === "unit" && n.unitNodeId !== null && (LED[userId] ?? []).includes(n.unitNodeId));
const reads = (userId: string, n: DemoNotice): boolean =>
  !isClientContact(userId) && n.tenantId === TENANT && n.withdrawnAt === null && (n.scope === "company" || (n.unitNodeId !== null && mayReadUnit(userId, n.unitNodeId)));
const isCurrent = (n: DemoNotice): boolean => n.endsOn === null || n.endsOn >= today();

function row(n: DemoNotice, userId: string) {
  return {
    id: n.id, scope: n.scope, unitNodeId: n.unitNodeId, unitName: n.unitNodeId === null ? null : (UNITS[n.unitNodeId] ?? null),
    title: n.title, body: n.body, pinned: n.pinned, endsOn: n.endsOn, state: isCurrent(n) ? "current" : "past",
    author: { id: n.authorId, name: NAMES[n.authorId] ?? "" }, createdAt: n.createdAt, editedAt: n.editedAt,
    canEdit: mayWrite(userId, n),
  };
}

const currentPins = (scope: DemoNotice["scope"], unit: string | null, exceptId?: string) =>
  notices.filter((n) => n.id !== exceptId && n.withdrawnAt === null && n.pinned && isCurrent(n) && n.scope === scope && n.unitNodeId === unit).length;

function list(userId: string, qs: URLSearchParams): DemoResult {
  if (isClientContact(userId)) return err(403, "not authorized");
  const unitParam = qs.get("unitNodeId");
  const scope = qs.get("scope");
  const state = qs.get("state") ?? "current";
  const hasUnit = unitParam !== null && unitParam !== "all";
  if (scope === "company" && hasUnit && unitParam !== "home") return err(400, "unitNodeId cannot be combined with scope=company", "unitNodeId");
  if (scope !== "company" && !hasUnit) return err(400, "unitNodeId is required (or scope=company)", "unitNodeId");
  if (state !== "current" && state !== "past") return err(400, "state must be current or past", "state");
  const rawLimit = qs.get("limit");
  let limit = LIST_DEFAULT;
  if (rawLimit !== null) {
    limit = Number(rawLimit);
    if (!/^\d{1,3}$/.test(rawLimit) || limit < 1 || limit > LIST_MAX) return err(400, `limit must be 1 to ${LIST_MAX}`, "limit");
  }
  const cursor = qs.get("cursor");
  let offset = 0;
  if (cursor) {
    const m = cursor.match(/^demo:(current|past):(\d+)$/);
    if (!m || m[1] !== state) return err(400, "cursor is not valid", "cursor");
    offset = Number(m[2]);
  }
  let visible: DemoNotice[];
  if (scope === "company") {
    visible = notices.filter((n) => reads(userId, n) && n.scope === "company");
  } else {
    const unit = unitParam as string;
    // The gate first: placed under the unit, leads it, or company-wide. Then existence (the root is not a unit).
    if (!mayReadUnit(userId, unit)) return err(403, "outside your reporting line");
    if (unit === ROOT || !UNITS[unit]) return err(404, "unit_not_found", "unitNodeId");
    visible = notices.filter((n) => reads(userId, n) && (n.scope === "company" || n.unitNodeId === unit));
  }
  const wanted = visible.filter((n) => (state === "current" ? isCurrent(n) : !isCurrent(n)));
  wanted.sort((a, b) => (state === "current" ? Number(b.pinned) - Number(a.pinned) : 0) || b.createdAt.localeCompare(a.createdAt) || b.seq - a.seq);
  const page = wanted.slice(offset, offset + limit);
  const next = offset + limit < wanted.length ? `demo:${state}:${offset + limit}` : null;
  return ok({ items: page.map((n) => row(n, userId)), nextCursor: next });
}

type Body = Record<string, unknown>;
function parse(body: string | undefined): Body | null {
  try {
    const v = body ? JSON.parse(body) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Body) : null;
  } catch { return null; }
}
const isIsoDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const clean = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\0/g, "").trim();

/** Validates the text fields in the server's order (title, body, pinned, endsOn), returning the first refusal. */
function validate(b: Body, keys: readonly string[], onPost: boolean): DemoResult | null {
  for (const k of Object.keys(b)) if (!keys.includes(k)) return err(400, `${k} is not a field of a notice`, k);
  if ("title" in b || onPost) {
    if (typeof b.title !== "string") return err(400, "title is required", "title");
    const n = [...clean(b.title)].length;
    if (n < 1 || n > TITLE_MAX) return err(400, `title must be 1 to ${TITLE_MAX} characters`, "title");
  }
  if ("body" in b || onPost) {
    if (typeof b.body !== "string") return err(400, "body is required", "body");
    const n = [...clean(b.body)].length;
    if (n < 1 || n > BODY_MAX) return err(400, `body must be 1 to ${BODY_MAX} characters`, "body");
  }
  if ("pinned" in b && typeof b.pinned !== "boolean") return err(400, "pinned must be true or false", "pinned");
  if ("endsOn" in b && !(b.endsOn === null && !onPost)) {
    if (!isIsoDay(b.endsOn)) return err(400, "endsOn must be a date, YYYY-MM-DD", "endsOn");
    if (onPost && b.endsOn < today()) return err(400, "endsOn must not be before today", "endsOn");
  }
  return null;
}

function post(userId: string, body: string | undefined): DemoResult {
  if (isClientContact(userId)) return err(403, "not authorized");
  const b = parse(body);
  if (!b) return err(400, "the body must be an object", "scope");
  // Authorization reads ONLY `scope` and `unitNodeId`; anything but exactly "unit" is checked as company-wide (company admin alone).
  const isUnit = b.scope === "unit";
  const unit = typeof b.unitNodeId === "string" ? b.unitNodeId : null;
  if (!mayWrite(userId, isUnit ? { scope: "unit", unitNodeId: unit } : { scope: "company", unitNodeId: null })) return err(403, "not authorized");
  if (b.scope !== "unit" && b.scope !== "company") return err(400, "scope must be unit or company", "scope");
  if (isUnit) {
    if (unit === null || unit.trim() === "") return err(400, "unitNodeId is required for a unit notice", "unitNodeId");
  } else if ("unitNodeId" in b && b.unitNodeId !== undefined && b.unitNodeId !== null) {
    return err(400, "a company-wide notice has no unitNodeId", "unitNodeId");
  }
  const bad = validate(b, ["scope", "unitNodeId", "title", "body", "pinned", "endsOn"], true);
  if (bad) return bad;
  if (isUnit && (unit === ROOT || !UNITS[unit as string])) return err(404, "unit_not_found", "unitNodeId");
  const pinned = b.pinned === true;
  if (pinned && currentPins(isUnit ? "unit" : "company", isUnit ? unit : null) >= PIN_MAX) return err(409, "pin_limit", "pinned");
  const n: DemoNotice = {
    id: nid(), tenantId: TENANT, scope: isUnit ? "unit" : "company", unitNodeId: isUnit ? unit : null, title: clean(b.title as string), body: clean(b.body as string),
    pinned, endsOn: typeof b.endsOn === "string" ? b.endsOn : null, authorId: userId, createdAt: new Date().toISOString(), editedAt: null, withdrawnAt: null, seq: ++seq,
  };
  notices.push(n);
  return ok(row(n, userId), 201);
}

const find = (id: string): DemoNotice | undefined => notices.find((n) => n.id === id);

function patch(userId: string, id: string, body: string | undefined): DemoResult {
  const n = find(id);
  // An unreadable notice is 404 for every named-notice route; a reader who may not edit it is 403, even with an invalid body.
  if (!n || !reads(userId, n)) return err(404, "notice_not_found");
  if (!mayWrite(userId, n)) return err(403, "not authorized");
  const b = parse(body);
  if (!b) return err(400, "the body must be an object", "title");
  if (Object.keys(b).length === 0) return err(400, "nothing to change");
  const bad = validate(b, ["title", "body", "pinned", "endsOn"], false);
  if (bad) return bad;
  const nowPinned = "pinned" in b ? b.pinned === true : n.pinned;
  const nowEnds = "endsOn" in b ? (b.endsOn as string | null) : n.endsOn;
  const wasCurrentPin = n.pinned && isCurrent(n);
  const willBeCurrentPin = nowPinned && (nowEnds === null || nowEnds >= today());
  if (willBeCurrentPin && !wasCurrentPin && currentPins(n.scope, n.unitNodeId, n.id) >= PIN_MAX) return err(409, "pin_limit", "pinned");
  if (typeof b.title === "string") n.title = clean(b.title);
  if (typeof b.body === "string") n.body = clean(b.body);
  if ("pinned" in b) n.pinned = nowPinned;
  if ("endsOn" in b) n.endsOn = nowEnds;
  n.editedAt = new Date().toISOString();
  return ok(row(n, userId));
}

function withdraw(userId: string, id: string): DemoResult {
  const n = find(id);
  if (!n || !reads(userId, n)) return err(404, "notice_not_found");
  if (!mayWrite(userId, n)) return err(403, "not authorized");
  n.withdrawnAt = new Date().toISOString();
  return ok({ id: n.id, withdrawnAt: n.withdrawnAt });
}

/** `/api/:t/notices`, `/api/:t/notices/:id` and `/api/:t/notices/:id/withdraw`. Null for any other path. */
export function noticesDemo(method: string, p: string, qs: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const m = p.match(/^\/api\/([^/]+)\/notices(?:\/([^/]+))?(?:\/(withdraw))?$/);
  if (!m) return null;
  const [, tenant, rawId, verbSeg] = m;
  const id = rawId ? decodeURIComponent(rawId) : null;
  const verb = method.toUpperCase();
  // Another company has no notices in the demo: the lists are empty and a named notice is not found.
  if (tenant !== TENANT) {
    if (verb === "GET" && id === null && !isClientContact(userId)) return ok({ items: [], nextCursor: null });
    return err(404, "notice_not_found");
  }
  if (id === null) {
    if (verb === "GET") return list(userId, qs);
    if (verb === "POST") return post(userId, body);
    return err(404, "not_found");
  }
  if (verbSeg === "withdraw") return verb === "POST" ? withdraw(userId, id) : err(404, "not_found");
  if (verb === "GET") {
    const n = find(id);
    return n && reads(userId, n) ? ok(row(n, userId)) : err(404, "notice_not_found");
  }
  if (verb === "PATCH") return patch(userId, id, body);
  return err(404, "not_found");
}
