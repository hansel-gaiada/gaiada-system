// AIP-13b (BFF §65, PERMISSION-CONTRACT §56, owner ruling AIP-D10): a department's own assistant guidance, client-safe half. The wire shape of
// both routes (§65.1), the words, and the pure rules the page, the form and the tab share. No server import and no I/O, so the `"use client"`
// editor can use it and every rule here is a plain unit test. The reader is `assistantGuidance-data.ts`, the write `assistantGuidanceActions.ts`.
//
// Nothing here decides who may do what. `mayEditPreamble` mirrors Cerbos (`assistant.preamble.edit`) so a person is not OFFERED a form the
// server will refuse; the server stays the authority on every read and write (PERMISSION-CONTRACT §56) and its refusals are shown as said.
import { canInUnit, type Capability } from "./rbac";
import type { Me } from "./platform";

/** §65.1: the answer of `GET` and `PUT /api/:tenant/departments/:unitNodeId/assistant-preamble`. */
export interface PreambleView {
  unitNodeId: string;
  department: { name: string; key: string } | null;
  /** The department's own text, or null when it uses the default. */
  custom: string | null;
  /** The registry default for the department's key, or null (a department with none). */
  defaultText: string | null;
  /** `custom ?? defaultText`: what the assistant uses. */
  effective: string | null;
  /** When the custom text was last written (ISO), null without custom text. */
  updatedAt: string | null;
  /** The last editor, null without custom text or after that person's erasure. */
  updatedBy: { id: string; name: string } | null;
  /** The department block of the prompt EXACTLY as the assistant reads it. Shown verbatim, never recomputed here. */
  preview: string | null;
  /** Is department guidance used by the assistant in this company at all (the company switch)? False: saving still works. */
  contextEnabled: boolean;
}

/** The server caps the text at this many CODE POINTS (`PREAMBLE_MAX_CHARS`, the table's `char_length` check). */
export const PREAMBLE_MAX = 1000;

/** Code points, as the server and Postgres count them (a JS string's `.length` counts UTF-16 units, so an emoji is 2). */
export const cpLength = (s: string): number => Array.from(s).length;

/** The text as the server will measure it: CRLF becomes LF and the ends are trimmed. (It also scrubs e-mail addresses and card numbers
 *  before it measures; that can only be seen on the server, which then answers a 400 in words.) */
export const measuredText = (s: string): string => s.replace(/\r\n?/g, "\n").trim();

/** The page's address for a unit's assistant guidance. */
export const assistantGuidanceHref = (unitNodeId: string): string => `/departments/${encodeURIComponent(unitNodeId)}/assistant-guidance`;

/** What the editor starts from: the custom text, else the default, else nothing. */
export const startingText = (v: Pick<PreambleView, "custom" | "defaultText">): string => v.custom ?? v.defaultText ?? "";

/** What a person has to know about the length: the count against the limit, and whether it can be saved. */
export function lengthState(text: string): { count: number; over: number; ok: boolean } {
  const count = cpLength(measuredText(text));
  const over = Math.max(0, count - PREAMBLE_MAX);
  return { count, over, ok: over === 0 };
}

/** The same count the way the editor words it: "412 of 1,000 characters", "37 over the 1,000 character limit". */
export function countLabel(text: string): string {
  const { count, over } = lengthState(text);
  const fmt = (n: number) => n.toLocaleString("en-US");
  return over > 0 ? `${fmt(count)} of ${fmt(PREAMBLE_MAX)} characters: ${fmt(over)} over the limit` : `${fmt(count)} of ${fmt(PREAMBLE_MAX)} characters`;
}

// ── Who is OFFERED the editor (a mirror, never the authority) ────────────────────────────────────

/** May the UI offer the editor? A unit's page passes the unit and its ancestors (`unitPath`, nearest first; a head's grant is unit-scoped, so
 *  `canInUnit`). The company admin and the owner pass with any path (or none). The server decides again, on both routes. */
export function mayEditPreamble(me: Me, tenantId: string | null | undefined, unitPath: readonly string[]): boolean {
  const cap: Capability = "assistant.preamble.edit";
  return canInUnit(me, cap, tenantId, unitPath);
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────

export const GUIDANCE_FORBIDDEN = "Only this department's head or a company admin can change this.";
export const GUIDANCE_NOT_FOUND = "This department was not found. It may have been removed, or it is not a department of this company.";
export const GUIDANCE_SECRET_NOTE =
  "Everyone who uses the assistant in this department gets this text, and the assistant may repeat it. Keep anything secret out of it.";
export const GUIDANCE_OFF_NOTE =
  "The assistant does not use department guidance in this company yet. You can still write and save the text; it takes effect when the company turns department guidance on.";

/** The server's refusal, in words for the form. A 400 is the server's own sentence (it names the field); a 403 and a 404 are said plainly. */
export function guidanceErrorText(e: { status: number; message: string }): string {
  if (e.status === 403) return GUIDANCE_FORBIDDEN;
  if (e.status === 404) return GUIDANCE_NOT_FOUND;
  if (e.status === 400) return e.message || "The text could not be saved. Check it and try again.";
  return e.message || "The text could not be saved just now. Try again.";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10-29T10:00:00.000Z` becomes "29 Oct 2026" (the UTC day). Pure string work, so the server and the client always agree. "" if unreadable. */
export function guidanceDay(iso: string | null | undefined): string {
  const m = typeof iso === "string" ? /^(\d{4})-(\d{2})-(\d{2})T/.exec(iso) : null;
  if (!m) return "";
  const month = Number(m[2]);
  if (month < 1 || month > 12) return "";
  return `${Number(m[3])} ${MONTHS[month - 1]} ${m[1]}`;
}

/** Who changed it last and when, in one sentence. With no custom text: nobody has, and the default stands. */
export function changedLine(v: Pick<PreambleView, "custom" | "updatedAt" | "updatedBy">): string {
  if (v.custom === null) return "Nobody has changed it: the assistant uses the default.";
  const day = guidanceDay(v.updatedAt);
  const who = v.updatedBy?.name?.trim();
  if (who && day) return `Last changed by ${who} on ${day}.`;
  if (who) return `Last changed by ${who}.`;
  if (day) return `Last changed on ${day}.`;
  return "Changed by someone who is no longer in the company.";
}

/** The result of a save, as the editor gets it from the server action. */
export type GuidanceActionResult = { ok: true; view: PreambleView } | { ok: false; error: string; field?: string };

/** The answer, checked: only an object with the §65.1 fields counts. Anything else is a failed read or write, never an empty text. */
export function asPreambleView(raw: unknown): PreambleView {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  if (!o || typeof o.unitNodeId !== "string") throw new Error("the guidance answer had no unit");
  const dept = o.department && typeof o.department === "object" ? (o.department as Record<string, unknown>) : null;
  const by = o.updatedBy && typeof o.updatedBy === "object" ? (o.updatedBy as Record<string, unknown>) : null;
  return {
    unitNodeId: o.unitNodeId,
    department: dept && typeof dept.name === "string" ? { name: dept.name, key: str(dept.key) ?? "" } : null,
    custom: str(o.custom),
    defaultText: str(o.defaultText),
    effective: str(o.effective),
    updatedAt: str(o.updatedAt),
    updatedBy: by && typeof by.id === "string" ? { id: by.id, name: str(by.name) ?? "" } : null,
    preview: str(o.preview),
    // An answer from a platform that predates the field: treat the switch as off rather than claim the text is in use.
    contextEnabled: o.contextEnabled === true,
  };
}
