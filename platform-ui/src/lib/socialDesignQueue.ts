// SCP-1h — the designer's queue: types and pure helpers (BFF §63.6.6 `GET design-queue`, §63.17 row `design-queue`). No server-only import,
// so a client component may import the values. The reader is `lib/socialDesignQueue-data.ts` (server-only, `ReadResult`).
//
// WHAT THE LIST IS. The posts the caller may design now: a post in `design` or in a design `changes` case, whose month request's task names them
// (Creatives), or any in-team post when they hold `social_designer`. The server narrows each row by those two facts; this file only draws the
// answer. A person with neither fact gets an empty list, which is the true answer ("nothing to design"), and the page says so in those words.
// The answer is parsed defensively: a 200 with the wrong shape reads as "cannot tell", never as an empty queue.
import { asHealth, type Health } from "./socialCycles";

export interface DesignQueueItem {
  postId: string;
  clientName: string;
  title: string;
  format: string | null;
  creativeState: string | null;
  /** The note that asked for this revision (a change the final check or the client asked for), or null when the post is not a revision. */
  revisionNote: string | null;
  readyBy: string;
  health: Health | null;
  thumbFileId: string | null;
}

export interface DesignQueuePage { items: DesignQueueItem[]; nextCursor: string | null }

export const DESIGN_QUEUE_PAGE_SIZE = 30;

export const CREATIVE_STATE_LABEL: Readonly<Record<string, string>> = {
  not_started: "Not started", in_progress: "In progress", revision: "Revision", submitted: "Submitted",
};
export const FORMAT_LABEL: Readonly<Record<string, string>> = { feed: "Feed", carousel: "Carousel", reel: "Reel", story: "Story" };

export const creativeStateLabel = (s: string | null): string => (s ? CREATIVE_STATE_LABEL[s] ?? s : "Not started");
export const formatLabel = (f: string | null): string => (f ? FORMAT_LABEL[f] ?? f : "No format yet");

/** The post page a row opens (`{D}/posts/[postId]`, §63.17). */
export const designQueuePostHref = (deptId: string, postId: string): string =>
  `/departments/${encodeURIComponent(deptId)}/posts/${encodeURIComponent(postId)}`;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function asItem(raw: unknown): DesignQueueItem {
  if (!isObj(raw)) throw new Error("design queue: an item is not an object");
  const postId = str(raw.postId);
  const title = typeof raw.title === "string" ? raw.title : null;
  const readyBy = str(raw.readyBy);
  if (!postId || title === null || !readyBy) throw new Error("design queue: an item has no post, title or ready-by");
  return {
    postId, title, readyBy, clientName: str(raw.clientName) ?? "A client", format: str(raw.format), creativeState: str(raw.creativeState),
    revisionNote: str(raw.revisionNote), health: asHealth(raw.health), thumbFileId: str(raw.thumbFileId),
  };
}

/** `GET design-queue`'s `{items, nextCursor}`. Throws on a body that is not one. */
export function asDesignQueue(raw: unknown): DesignQueuePage {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error("design queue: not a list");
  return { items: raw.items.map(asItem), nextCursor: str(raw.nextCursor) };
}
