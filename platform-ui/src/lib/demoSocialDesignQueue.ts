import "server-only";
// SCP-1h (BFF §63.6.6, §63.16) — what DEMO_MODE answers for the designer's queue and for the request detail's `socialPosts`, from the demo
// pipeline store (`demoSocialPipeline.ts`): the invented posts at the design step and the design change cases, and the month requests those
// posts name. Nothing is stored here: both answers are derived from the posts every time, so they always agree with the post page.
//
// The queue follows the server's two facts for the DEMO CALLER (`userId`): a `creatives` post is the Creatives designer's (the person named on the
// month request's task: `u-creative`), an `in_team` post is the in-team designer's (a holder of social_designer: `u-social-design`). Anyone else,
// the HoD and the superadmin included, gets an honest empty queue, as on the server. A client contact is refused at the outer gate.
import { PIPE_POSTS, PIPE_ENGAGEMENTS, demoPostHealth, type PipePost } from "./demoSocialPipeline";

interface DemoResult { status: number; json: unknown }

/** The person the demo's Creatives month requests name on their task, and the in-team designer (`social_designer`). */
const CREATIVES_DESIGNER = "u-creative";
const IN_TEAM_DESIGNER = "u-social-design";
const isClientContact = (userId: string) => userId.startsWith("demo-client") || userId === "demo-two-company-client";

const PAGE_DEFAULT = 30;
const PAGE_MAX = 100;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** At the design step, or back for a change to the design (the two change cases whose holder is the designer). */
const atDesign = (p: PipePost): boolean => p.pipelineStatus === "design" || (p.pipelineStatus === "changes" && p.changeKind === "design");
const designerOf = (p: PipePost): string | null => (p.creativeSource === "in_team" ? IN_TEAM_DESIGNER : p.creativeSource === "creatives" ? CREATIVES_DESIGNER : null);
const clientNameOf = (engagementId: string): string => PIPE_ENGAGEMENTS.find((e) => e.id === engagementId)?.clientName ?? "A client";

const bad = (field: string): DemoResult => ({ status: 400, json: { error: "invalid_field", field } });

/** `GET design-queue?cursor=&limit=`: ordered by ready-by, then when the post reached its step, then the id; the cursor is an offset (opaque to callers). */
export function demoDesignQueue(userId: string, params: URLSearchParams): DemoResult {
  if (isClientContact(userId)) return { status: 403, json: { error: "not authorized: cerbos denied read on work_request" } };
  let limit = PAGE_DEFAULT;
  if (params.get("limit")) {
    const raw = params.get("limit") as string;
    const n = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > PAGE_MAX) return bad("limit");
    limit = n;
  }
  let offset = 0;
  if (params.get("cursor")) {
    const m = /^o:(\d{1,6})$/.exec(Buffer.from(params.get("cursor") as string, "base64url").toString("utf8"));
    if (!m) return bad("cursor");
    offset = Number(m[1]);
  }
  const mine = PIPE_POSTS.filter((p) => atDesign(p) && designerOf(p) === userId)
    .map((p) => ({ p, health: demoPostHealth(p) as { readyBy: string } }))
    .sort((a, b) => a.health.readyBy.localeCompare(b.health.readyBy) || a.p.statusSince.localeCompare(b.p.statusSince) || a.p.id.localeCompare(b.p.id));
  const page = mine.slice(offset, offset + limit);
  const items = page.map(({ p, health }) => ({
    postId: p.id, clientName: clientNameOf(p.engagementId), title: p.title, format: p.format, creativeState: p.creativeState,
    revisionNote: p.pipelineStatus === "changes" ? p.changeNote : null, readyBy: health.readyBy, health, thumbFileId: null,
  }));
  const next = offset + limit < mine.length ? Buffer.from(`o:${offset + limit}`, "utf8").toString("base64url") : null;
  return { status: 200, json: { items, nextCursor: next } };
}

/** The month requests the demo posts name (`creativeRequestId`), as the title, the receiving unit and the date a request opened by `approve_for_design` carries. */
export function demoMonthRequests(): Array<{ id: string; title: string; neededBy: string }> {
  const out = new Map<string, { id: string; title: string; neededBy: string }>();
  for (const p of PIPE_POSTS) {
    if (!p.creativeRequestId || out.has(p.creativeRequestId)) continue;
    const [y, m] = p.cycleMonth.split("-").map(Number);
    out.set(p.creativeRequestId, {
      id: p.creativeRequestId, title: `${clientNameOf(p.engagementId)} · ${MONTH_NAMES[m - 1]} ${y} social designs`,
      neededBy: (demoPostHealth(p) as { readyBy: string }).readyBy,
    });
  }
  return [...out.values()];
}

/** The request detail's `socialPosts` (§63.6.6): the posts that joined the request; [] for a request no post joined. `href` opens the post page. */
export function demoRequestSocialPosts(requestId: string, socialDeptId: string): Array<Record<string, unknown>> {
  return PIPE_POSTS.filter((p) => p.creativeRequestId === requestId).map((p) => ({
    postId: p.id, title: p.title, clientName: clientNameOf(p.engagementId), pipelineStatus: p.pipelineStatus, creativeState: p.creativeState,
    href: `/departments/${encodeURIComponent(socialDeptId)}/posts/${encodeURIComponent(p.id)}`,
  }));
}
