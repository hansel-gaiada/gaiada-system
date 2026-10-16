// DW-10a-2: the Overview's Notices blocks (BFF §57.8), as pure rules: where each is placed and how a read becomes a block. No React and no
// server imports, so every rule here is a plain unit test.
//
// Two blocks, two keys, one rule (as `client-health` and `company-client-health`): `notices` is a department workspace's block and reads for the
// workspace's org node; `company-notices` is the company Overview's and reads the company-wide notices, never narrowed, whatever node the frame
// carries. The Office of the GM is a workspace WITH a node, but its Overview lists `company-notices`, so a department read never narrows it.
// Both are `fixed` (DW-D34): a notice is what the unit's head or the company wants a person to know, so it cannot be switched off.
//
// ── WHEN THE BLOCK IS DRAWN ─────────────────────────────────────────────────────────────────────────
//   - the read FAILED or was REFUSED: "Unavailable", never an empty block (a refusal is not "no notices");
//   - the read succeeded and returned at least one current notice: the notices, pinned first, at most three;
//   - the read succeeded, nothing is current, and the person MAY POST: "No current notices" and "Post a notice";
//   - the read succeeded, nothing is current, and the person may not post: NOTHING. An empty notice board says nothing a reader needs.
import type { ReadResult } from "./readResult";
import {
  BLOCK_NOTICES_MAX, noticeAge, noticeExcerpt, noticeHref, noticeUnitLabel, pinnedFirst, type NoticeList,
} from "./notices";

export const NOTICES_KEY = "notices";
export const COMPANY_NOTICES_KEY = "company-notices";

/** The department block reads for the department's org node, so a workspace with no node (HR, Finance or IT before they have one) has nothing to
 *  read and does not place it. Other widget keys are not this rule's business and stay placed. */
export function noticesWidgetPlaced(key: string, subject: { deptId: string | null }): boolean {
  return key !== NOTICES_KEY || !!subject.deptId;
}

export interface NoticeBlockRow {
  id: string;
  title: string;
  /** "Whole company", the unit's own name, or "From <unit>" (posted to a unit above this one). */
  unitLabel: string;
  /** "3 h ago". */
  age: string;
  /** The first 140 characters of the body, as plain text. */
  excerpt: string;
  pinned: boolean;
  /** Where the notice is on its board (`/departments/<unit>/notices#<id>` or `/notices#<id>`). */
  href: string;
}

export type NoticesBlockView =
  /** A refused read and a failed one read the same here: the block says "Unavailable" and nothing else. */
  | { kind: "unavailable" }
  /** A successful read with nothing current, for a person who may not post: the block is not drawn. */
  | { kind: "hidden" }
  | {
      kind: "ok";
      /** At most three current notices, pinned first. Empty only for a person who may post. */
      rows: NoticeBlockRow[];
      canPost: boolean;
    };

/** `here` is the department's node id for the department block (so a notice posted to a unit above reads "From <unit>"), null for the company's. */
export function noticesBlockView(result: ReadResult<NoticeList>, canPost: boolean, here: string | null, now: number = Date.now()): NoticesBlockView {
  // A refused read draws nothing (a visitor from another department has no business with this unit's notices; the DW-3k condition block's
  // rule). A failed read says "Unavailable", never an empty block.
  if (result.kind === "forbidden") return { kind: "hidden" };
  if (result.kind !== "ok") return { kind: "unavailable" };
  const current = pinnedFirst(result.data.items.filter((n) => n.state === "current"));
  if (current.length === 0) return canPost ? { kind: "ok", rows: [], canPost } : { kind: "hidden" };
  return {
    kind: "ok",
    rows: current.slice(0, BLOCK_NOTICES_MAX).map((n) => ({
      id: n.id,
      title: n.title,
      unitLabel: noticeUnitLabel(n, here),
      age: noticeAge(n.createdAt, now),
      excerpt: noticeExcerpt(n.body),
      pinned: n.pinned,
      href: noticeHref(n.scope, n.unitNodeId, n.id),
    })),
    canPost,
  };
}
