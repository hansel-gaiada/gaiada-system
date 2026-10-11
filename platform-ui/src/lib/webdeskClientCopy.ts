// WSK-49d — every refusal a CLIENT editor can meet, in plain words, in ONE place.
//
// PURE (no server imports): the shared editor components (client mode), the portal pages and the tests all map a
// `WdResult` to words here, so the copy cannot drift between the item editor, the restore button, the publish panel
// and the requests list. The slugs are §16j's exact problem slugs; the words for the refusals the owner's brief names
// are the brief's, verbatim (`CLIENT_COPY`). Nothing here ever prints a problem document: a refusal is a sentence.
//
// The portal's mapper (`lib/portalWebsite.ts`) puts `slug` on the `invalid` / `forbidden` results it returns, because
// `resultFromError` keeps the slug only for 409/404. `slug` is absent on every staff result.
import { fieldLabel, humanize, isOutcomeUnknown, unconfirmedCopy, type FieldDef, type WdResult } from "./webdeskContentModel";

export const CLIENT_COPY = {
  versionConflict: "This page changed since you opened it. Reload to see the latest, then make your change again.",
  publishNotClientEditable: "This draft includes changes only Gaiada can publish. Gaiada will publish it, or you can restore the live version and edit again.",
  selfApprovedBatch: "Another person from your company needs to approve this.",
  noScheduling: "Scheduling isn't available to you. Publish now, or ask a colleague from your company to approve a request.",
  noEditAccess: "You don't have website editing access. Ask your company's admin.",
  itemDeleted: "This page has been deleted, so it can't be changed or published.",
  managed: "Managed by Gaiada.",
  createBlocked: "This collection has required fields only Gaiada can fill",
} as const;

/** §16j's slugs for the refusals that need their own words. */
export const SLUG = {
  versionConflict: "version-conflict",
  itemDeleted: "item-deleted",
  fieldNotClientEditable: "field-not-client-editable",
  publishNotClientEditable: "publish-not-client-editable",
  clientCommandNotAllowed: "client-command-not-allowed",
  approvalNotPending: "approval_not_pending",
} as const;

export type ClientOp = "save" | "create" | "restore" | "publish" | "request" | "approve" | "withdraw" | "read";

const OP_WORDS: Record<ClientOp, { what: string; nothing: string }> = {
  save: { what: "the save", nothing: "Nothing was saved." },
  create: { what: "the new page", nothing: "Nothing was created." },
  restore: { what: "the restore", nothing: "Nothing was restored." },
  publish: { what: "the publish", nothing: "Nothing was published." },
  request: { what: "the request", nothing: "No request was filed." },
  approve: { what: "the approval", nothing: "Nothing was published." },
  withdraw: { what: "the withdrawal", nothing: "The request was not withdrawn." },
  read: { what: "that", nothing: "" },
};

export interface ClientRefusal {
  tone: "bad" | "warn" | "info";
  text: string;
  /** The write's outcome is UNKNOWN (never "saved", never "failed"): the caller blocks writes until a re-read. */
  unknown?: boolean;
}

/** RFC 6901 pointers (`/blocks/0/props/faq/2/answer`, `/seo/title`, `/collectionKey`, `/items/1/blocks/0/...`) to the words a
 *  client reads: field labels from the composition (indexes skipped), "Search appearance (SEO)" for anything under `/seo`. */
export function describePaths(paths: string[], defs: FieldDef[] | undefined, itemLabels?: string[]): string[] {
  const out: string[] = [];
  const add = (s: string) => { if (!out.includes(s)) out.push(s); };
  for (const raw of paths) {
    let segs = raw.split("/").slice(1).map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"));
    let prefix = "";
    // A publish names the item first: `/items/<index>/...`.
    if (segs[0] === "items" && /^\d+$/.test(segs[1] ?? "")) {
      const label = itemLabels?.[Number(segs[1])];
      prefix = label ? `${label}: ` : `Item ${Number(segs[1]) + 1}: `;
      segs = segs.slice(2);
    }
    if (segs[0] === "seo") { add(`${prefix}Search appearance (SEO)`); continue; }
    if (segs[0] === "collectionKey") { add(`${prefix}this whole section`); continue; }
    if (segs[0] === "blocks" && segs[1] === "0" && segs[2] === "props" && segs.length > 3) {
      let level = defs ?? [];
      const labels: string[] = [];
      for (const seg of segs.slice(3)) {
        if (/^\d+$/.test(seg)) continue;
        const def = level.find((d) => d.name === seg);
        if (!def) { labels.push(humanize(seg)); break; }
        labels.push(fieldLabel(def));
        level = def.fields ?? [];
      }
      add(`${prefix}${labels.join(" > ")}`);
      continue;
    }
    if (segs[0] === "blocks") { add(`${prefix}Other content on this page`); continue; }
    add(`${prefix}Part of this page`);
  }
  return out;
}

/**
 * The words for a refused write or read. `defs` (the collection's fields) and `itemLabels` only sharpen the sentence that
 * names fields or items; every branch has a complete sentence without them.
 */
export function clientRefusal(
  r: Exclude<WdResult<unknown>, { kind: "ok" }>,
  op: ClientOp,
  ctx: { defs?: FieldDef[]; itemLabels?: string[] } = {},
): ClientRefusal {
  const w = OP_WORDS[op];
  const nothing = w.nothing ? ` ${w.nothing}` : "";
  switch (r.kind) {
    case "conflict":
      if (r.slug === SLUG.versionConflict) return { tone: "bad", text: CLIENT_COPY.versionConflict };
      if (r.slug === SLUG.itemDeleted) return { tone: "bad", text: CLIENT_COPY.itemDeleted };
      if (r.slug === SLUG.approvalNotPending) return { tone: "info", text: "This request has already been decided. Reload to see what happened." };
      if (r.slug === "slug-taken") return { tone: "bad", text: "That page address is already used in this collection. Choose another." };
      if (r.slug === "twin-locale-taken") return { tone: "bad", text: "That language already has a version of this page." };
      if (r.slug === "singleton-exists") return { tone: "bad", text: "This collection holds one page per language, and it already exists." };
      return { tone: "bad", text: `That couldn't be done: ${r.message}${nothing}` };
    case "invalid": {
      if (r.slug === SLUG.publishNotClientEditable) {
        const named = describePaths(r.issues.map((i) => i.path), ctx.defs, ctx.itemLabels);
        return { tone: "bad", text: `${CLIENT_COPY.publishNotClientEditable}${named.length ? ` Gaiada-only changes: ${named.join("; ")}.` : ""}` };
      }
      if (r.slug === SLUG.fieldNotClientEditable) {
        const named = describePaths(r.issues.map((i) => i.path), ctx.defs);
        return {
          tone: "bad",
          text: `${w.nothing || "Nothing was written."} These can only be changed by Gaiada: ${named.length ? named.join("; ") : "some of the fields you changed"}. Undo your change to ${named.length === 1 ? "it" : "them"}, then try again. Your other edits are still here.`,
        };
      }
      return { tone: "bad", text: `${r.message || "That isn't allowed."}${nothing}` };
    }
    case "forbidden":
      if (r.slug === SLUG.clientCommandNotAllowed) return { tone: "bad", text: CLIENT_COPY.noScheduling };
      if (op === "approve") return { tone: "bad", text: CLIENT_COPY.selfApprovedBatch };
      return { tone: "bad", text: `You don't have permission to do that. Ask your company's admin.${nothing}` };
    case "not_found":
      if (r.slug === "item-not-found") return { tone: "bad", text: "This page no longer exists." };
      if (r.slug === "version-not-found") return { tone: "bad", text: "That version no longer exists." };
      if (r.slug === "approval_not_found") return { tone: "bad", text: "This request is no longer available. Reload to see the current list." };
      if (r.slug === "collection-not-found") return { tone: "bad", text: "This collection isn't available to you." };
      return { tone: "bad", text: "This site isn't available to you." };
    case "not_enabled":
      return { tone: "info", text: "Website editing isn't available right now." };
    case "unavailable":
      if (isOutcomeUnknown(r)) return { tone: "warn", text: unconfirmedCopy(w.what), unknown: true };
      if (r.code === "contract_drift") return { tone: "bad", text: `The website service answered with something unexpected, so nothing was assumed done.${nothing} Your changes are still here. If this keeps happening, tell Gaiada.` };
      return { tone: "bad", text: `Couldn't reach the website service.${nothing} Try again in a moment; your changes are still here.` };
  }
}

/** Client-mode wording for a sentence the shared editor writes for staff: "WebDesk" is not a word a client has met. */
export function plainForClient(s: string): string {
  return s.replace(/(^|[.!?]\s)WebDesk/g, "$1The website service").replace(/WebDesk/g, "the website service");
}
