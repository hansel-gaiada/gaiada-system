"use server";
// M5-V6-c — one page of a recording's content, as a server action. The browser calls this; this calls the BFF (§28g
// `GET …/recordings/:id/chunks`); the browser never talks to the collector and nothing here returns a link or a file.
//
// The player keeps the opening: page 1 is asked for with `from = 0` (sent as NO `from`, which the API reads as the opening and which
// writes the one activity row), every later page with `from = nextFrom` and the `opening` id page 1 returned. This action just
// forwards what it is given, after checking its shape: the API is the authority on whether the opening is still good (409).
//
// Capability first: a viewer without `search.replay.view` gets `forbidden` and NO read is made (a cosmetic mirror of Cerbos's
// `view_replay`: the server answers 403 on its own). Server actions may export only async functions, so the words and the shapes live
// in replaysModel.ts.
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";
import { ReplaysShapeError, UUID_RE, classifyReplayFailure, parseChunksPage, type PageResult } from "./replaysModel";

/** The collector keeps at most 1000 chunks (seq 0..999) per recording; `from` is a chunk number. */
const FROM_MAX = 999;

export async function readReplayPageAction(propertyId: string, recordingId: string, from: number, opening: string | null): Promise<PageResult> {
  const userId = await getSessionUserId();
  if (!userId) return { kind: "signed_out" };
  const me = await getMe(userId);
  const company = await getActiveTenant(me);
  if (!company) return { kind: "forbidden" };
  // A cosmetic gate (Cerbos is the authority): without the capability no read is made.
  if (!can(me, "search.replay.view", company)) return { kind: "forbidden" };

  if (typeof propertyId !== "string" || !UUID_RE.test(propertyId) || typeof recordingId !== "string" || !UUID_RE.test(recordingId)) return { kind: "bad_request" };
  if (typeof from !== "number" || !Number.isInteger(from) || from < 0 || from > FROM_MAX) return { kind: "bad_request" };
  if (opening !== null && (typeof opening !== "string" || !UUID_RE.test(opening))) return { kind: "bad_request" };
  // A later page without its opening can only be a 409; say so without a round trip.
  if (from > 0 && opening === null) return { kind: "not_opened" };

  const q = new URLSearchParams();
  if (from > 0) { q.set("from", String(from)); q.set("opening", opening as string); }
  const path = `/api/${encodeURIComponent(company)}/modules/search/properties/${encodeURIComponent(propertyId)}/recordings/${encodeURIComponent(recordingId)}/chunks${q.size ? `?${q.toString()}` : ""}`;
  try {
    return { kind: "ok", page: parseChunksPage(await platformFetch<unknown>(path, userId)) };
  } catch (e) {
    if (e instanceof ReplaysShapeError) return { kind: "drift", message: e.message };
    if (e instanceof PlatformError) {
      const reason = typeof e.reason === "string" ? e.reason : e.body && typeof e.body === "object" && typeof (e.body as { reason?: unknown }).reason === "string" ? (e.body as { reason: string }).reason : null;
      return classifyReplayFailure(e.status, reason);
    }
    return classifyReplayFailure(0, null);
  }
}
