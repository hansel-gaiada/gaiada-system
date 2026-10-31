// SCP-6a — the one-off sheet import, the PURE half (BFF §63.23; plan §8 SCP-6, SCP-D10). No I/O in this file: the controller
// (`sheet-import.controller.ts`) loads what the rows are matched against, calls these functions, and writes what they decide.
//
// WHAT IS HERE
//   1. `normalizeName`, the name matchers and the suggestions (63.23.2).
//   2. The lenient CELL READERS: whole numbers, creative source, batch, report format, network lists, formats, times, dates (dmy/mdy/ymd, English and
//      Indonesian month names), yes/no and hashtags (63.23.4, 63.23.5). A reader answers a value, or `undefined` for a cell it cannot read; an EMPTY
//      cell is never read (the callers skip it first: "an empty cell leaves the field as it is, the import never clears a value").
//   3. The body validator (`parseImportBody`, 63.23.2) and the two previews: `previewAllocation` (63.23.4) and, in two stages, the plan
//      (`stagePlanRows`, then `finishPlan` once the controller has read the cycles and the posts that exist, 63.23.5).
//
// NOTHING RESTATES A RULE. A value is read leniently here and then CHECKED by the rule that already owns it: the allocation's through
// `parseAllocationPatch` (63.4), every post field's through the machine's `contentFieldProblem` (`FIELD_VALUE_RULES`, 63.6.3). A value those refuse is
// refused here under the same field.
//
// THE POST'S ID is a uuid v5 of `tenantId|engagementId|month|date|normalized title` (a fixed namespace), so a replay of the same row finds its post.
import { BadRequestException } from "@nestjs/common";
import { v5 as uuidv5 } from "uuid";
import { instantInTz } from "../../../core/activity-kinds";
import { NETWORKS } from "./brand-book";
import { parseAllocationPatch } from "./allocation.controller";
import { columnOf, contentFieldProblem } from "./machine";

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Names
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Lower case, accents removed, punctuation turned into spaces, spaces collapsed, trimmed (BFF §63.23.2). */
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const wordsOf = (normalized: string): string[] => (normalized === "" ? [] : [...new Set(normalized.split(" "))]);

/**
 * Up to `limit` candidates whose normalized names share words with `sheetName`, the most shared words first; of equal sharing the shorter name (the
 * closer one), then by name. A candidate sharing no word is not offered.
 */
export function suggestNames<T extends { id: string; name: string }>(sheetName: string, candidates: readonly T[], limit = 3): T[] {
  const mine = new Set(wordsOf(normalizeName(sheetName)));
  const scored = candidates
    .map((c) => {
      const words = wordsOf(normalizeName(c.name));
      return { c, shared: words.filter((w) => mine.has(w)).length, size: words.length, key: normalizeName(c.name) };
    })
    .filter((x) => x.shared > 0);
  scored.sort((a, b) => b.shared - a.shared || a.size - b.size || (a.key < b.key ? -1 : a.key > b.key ? 1 : a.c.id < b.c.id ? -1 : 1));
  return scored.slice(0, limit).map((x) => x.c);
}

export type ClientMatch = { kind: "matched"; id: string } | { kind: "none" } | { kind: "ambiguous"; ids: string[] };

/** A client's name against the open engagements' client names (BFF §63.23.2): the person's pick wins, else exactly one name-equal engagement. */
export function matchClient(
  sheetName: string, engagements: ReadonlyArray<{ id: string; clientName: string }>, picks: ReadonlyMap<string, string>,
): ClientMatch {
  const norm = normalizeName(sheetName);
  const picked = picks.get(norm);
  if (picked) return { kind: "matched", id: picked };
  const hits = engagements.filter((e) => normalizeName(e.clientName) === norm);
  if (hits.length === 1) return { kind: "matched", id: hits[0].id };
  return hits.length === 0 ? { kind: "none" } : { kind: "ambiguous", ids: hits.map((h) => h.id) };
}

export type OfficerMatch = { kind: "matched"; id: string } | { kind: "none" } | { kind: "ambiguous" };

/** An officer's cell against the company's active employee members: the person's pick, else the email (exact, case ignored), else the name rule. */
export function matchOfficer(
  sheetName: string, members: ReadonlyArray<{ id: string; name: string; email: string }>, picks: ReadonlyMap<string, string>,
): OfficerMatch {
  const norm = normalizeName(sheetName);
  const picked = picks.get(norm);
  if (picked) return { kind: "matched", id: picked };
  const email = sheetName.trim().toLowerCase();
  const byEmail = members.filter((m) => m.email !== "" && m.email.toLowerCase() === email);
  if (byEmail.length === 1) return { kind: "matched", id: byEmail[0].id };
  const byName = members.filter((m) => normalizeName(m.name) === norm);
  if (byName.length === 1) return { kind: "matched", id: byName[0].id };
  return byName.length === 0 && byEmail.length === 0 ? { kind: "none" } : { kind: "ambiguous" };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The cell readers
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The first whole number in the cell (`12`, `12 posts`, `Day 5`), or undefined. */
export function readWholeNumber(cell: string): number | undefined {
  const m = /\d+/.exec(cell);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isSafeInteger(n) ? n : undefined;
}

const CREATIVE_SOURCES: Record<string, "creatives" | "in_team"> = {
  creatives: "creatives", creative: "creatives", "creative team": "creatives", "creatives team": "creatives", "creatives dept": "creatives",
  "creative dept": "creatives", "creatives department": "creatives", "creative department": "creatives",
  "in team": "in_team", "in house": "in_team", inhouse: "in_team", "social designer": "in_team", "own designer": "in_team",
  // Indonesian, as the SCP-6 dress rehearsal's mock sheet wrote them ("Tim Creative" for the Creatives team; an internal or sosmed designer).
  "tim creative": "creatives", "tim creatives": "creatives", "tim kreatif": "creatives", kreatif: "creatives", "divisi creative": "creatives",
  "divisi kreatif": "creatives", internal: "in_team", "desainer internal": "in_team", "designer internal": "in_team", "tim sosmed": "in_team",
  "desainer sosmed": "in_team", "designer sosmed": "in_team", "in house designer": "in_team", "inhouse designer": "in_team",
};
export function readCreativeSource(cell: string): "creatives" | "in_team" | undefined {
  return CREATIVE_SOURCES[normalizeName(cell)];
}

/** `A` or `B`, case ignored, also as "Batch A". */
export function readBatch(cell: string): "A" | "B" | undefined {
  const m = /^(?:batch )?([ab])$/.exec(normalizeName(cell));
  return m ? (m[1].toUpperCase() as "A" | "B") : undefined;
}

const REPORT_FORMATS: Record<string, "email" | "meeting"> = {
  email: "email", "e mail": "email", meeting: "meeting", call: "meeting", zoom: "meeting", meet: "meeting",
  "via email": "email", "lewat email": "email", rapat: "meeting", "google meet": "meeting", gmeet: "meeting", "online meeting": "meeting",
  "meeting online": "meeting", "via zoom": "meeting", "video call": "meeting",
};
export function readReportFormat(cell: string): "email" | "meeting" | undefined {
  return REPORT_FORMATS[normalizeName(cell)];
}

/** The `NETWORKS` keys, the networks' names and the team's short forms. */
const NETWORK_ALIASES: Record<string, string> = {
  ...Object.fromEntries(NETWORKS.map((n) => [n, n])),
  ig: "instagram", insta: "instagram", fb: "facebook", tt: "tiktok", "tik tok": "tiktok", li: "linkedin", "linked in": "linkedin",
  yt: "youtube", "you tube": "youtube", twitter: "x", "x twitter": "x", "twitter x": "x",
};

const LIST_SPLIT = /[,/+&;\n\r]+/;

/** The items of a list cell, split on `,` `/` `+` `&` `;` and new lines, each trimmed, the empty ones dropped. */
function listItems(cell: string): string[] {
  return cell.split(LIST_SPLIT).map((s) => s.trim()).filter((s) => s !== "");
}

/** A list cell's items, each read by `readItem` (one or more values), each value once, in the order written. One unreadable item refuses all. */
function readMappedList(cell: string, readItem: (item: string) => string[] | undefined): string[] | undefined {
  const items = listItems(cell);
  if (items.length === 0) return undefined; // a list of nothing would clear a field: not a value
  const out: string[] = [];
  for (const item of items) {
    const vs = readItem(item);
    if (vs === undefined) return undefined;
    for (const v of vs) if (!out.includes(v)) out.push(v);
  }
  return out;
}

// People write a format and a network together in one cell ("IG Story", "Carousel Post", "Reels IG", "Instagram Feed"), in either column.
// So an item that is not a known name as a whole is read word by word: each reader ignores the other reader's words and these fillers,
// and every word left must be its own. (SCP-6 dress rehearsal, 2026-10-29: 6 of 22 mock plan rows were refused for exactly these forms.)
const FILLER_WORDS = new Set(["post", "posts", "posting", "konten", "content", "upload", "unggahan"]);
const NETWORK_PHRASES: ReadonlyArray<[RegExp, string]> = [[/\btik tok\b/g, "tiktok"], [/\blinked in\b/g, "linkedin"], [/\byou tube\b/g, "youtube"]];

function itemWords(item: string): string[] {
  let n = normalizeName(item);
  for (const [re, w] of NETWORK_PHRASES) n = n.replace(re, w);
  return n.split(" ").filter((w) => w !== "");
}

function wordValues(words: readonly string[], table: Record<string, string>): string[] | undefined {
  if (words.length === 0) return undefined;
  const out: string[] = [];
  for (const w of words) {
    const v = table[w];
    if (v === undefined) return undefined;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function readNetworkItem(item: string): string[] | undefined {
  const whole = NETWORK_ALIASES[normalizeName(item)];
  if (whole !== undefined) return [whole];
  return wordValues(itemWords(item).filter((w) => FORMAT_ALIASES[w] === undefined && !FILLER_WORDS.has(w)), NETWORK_ALIASES);
}

/** A network list (`IG, FB`, `Instagram / TikTok`, `IG Story & FB`), mapped to the `NETWORKS` keys, each once, in the order written. */
export function readNetworks(cell: string): string[] | undefined {
  return readMappedList(cell, readNetworkItem);
}

const FORMAT_ALIASES: Record<string, string> = {
  feed: "feed", post: "feed", single: "feed", image: "feed", static: "feed", photo: "feed", foto: "feed",
  carousel: "carousel", slide: "carousel", slides: "carousel", album: "carousel",
  reel: "reel", reels: "reel", video: "reel",
  story: "story", stories: "story", igs: "story",
};

function readFormatItem(item: string): string[] | undefined {
  const whole = FORMAT_ALIASES[normalizeName(item)];
  if (whole !== undefined) return [whole];
  const words = itemWords(item).filter((w) => NETWORK_ALIASES[w] === undefined);
  const kept = words.filter((w) => !FILLER_WORDS.has(w));
  // "IG Post": only a network and a filler are left, and a post on its own is the feed.
  if (kept.length === 0) return words.some((w) => w === "post" || w === "posts") ? ["feed"] : undefined;
  // SCP-6b1: "Carousel Video" (a carousel whose slides are video) is a carousel. Every other cell naming two formats stays unreadable.
  if (kept.length === 2 && kept.includes("carousel") && kept.includes("video")) return ["carousel"];
  return wordValues(kept, FORMAT_ALIASES);
}

/** A format list (the allocation's `formats`; `Single Post, Carousel, IG Story`). */
export function readFormats(cell: string): string[] | undefined {
  return readMappedList(cell, readFormatItem);
}
/** One format (the plan's `format`): a cell naming two is not a value. */
export function readFormat(cell: string): string | undefined {
  const l = readFormats(cell);
  return l && l.length === 1 ? l[0] : undefined;
}

/** `HH:MM`, `H:MM`, `H.MM`, `9am`, `9 am`, `7:30 pm`; also the time part of `YYYY-MM-DD HH:MM` (a date-time cell). Answers `HH:MM` (24 hour). */
export function readTime(cell: string): string | undefined {
  let t = cell.trim().toLowerCase().replace(/\s+/g, " ");
  const stamp = /^\d{4}-\d{2}-\d{2}[ t]+(.+)$/.exec(t);
  if (stamp) t = stamp[1];
  t = t.replace(/^(\d{1,2})\.(\d{2})(?=$|[ ap])/, "$1:$2").replace(/\s*([ap])\.m\.?$/, " $1m");
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/.exec(t);
  if (!m) return undefined;
  if (m[2] === undefined && !m[3]) return undefined; // a bare number is not a time
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (min > 59) return undefined;
  if (m[3]) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (m[3] === "pm" ? 12 : 0);
  } else if (h > 23) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export type DateOrder = "dmy" | "mdy" | "ymd";
export const DATE_ORDERS: readonly DateOrder[] = ["dmy", "mdy", "ymd"];

const MONTH_NAMES: Record<string, number> = {
  // English
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  // Indonesian (the ones that differ; the rest are shared)
  januari: 1, februari: 2, maret: 3, mei: 5, juni: 6, juli: 7, agustus: 8, agu: 8, agt: 8, okt: 10, oktober: 10, nopember: 11, des: 12, desember: 12,
};
const WEEKDAYS = new Set([
  "monday", "mon", "tuesday", "tue", "tues", "wednesday", "wed", "thursday", "thu", "thur", "thurs", "friday", "fri", "saturday", "sat", "sunday", "sun",
  "senin", "selasa", "rabu", "kamis", "jumat", "sabtu", "minggu", "ahad",
]);

function realDate(y: number, m: number, d: number): string | undefined {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return undefined;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return undefined;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
const fullYear = (s: string): number | undefined => (s.length === 4 ? Number(s) : s.length === 2 ? 2000 + Number(s) : undefined);

/**
 * A date in the person's order (`dmy`, `mdy`, `ymd`), as `YYYY-MM-DD`; undefined when the cell is not a real date. `YYYY-MM-DD` (and any numeric form
 * that starts with a four-digit year) is always year-month-day. A month name is read as such, in English or Indonesian, with or without a weekday, a
 * day suffix (`3rd`) or a time part; without a year it takes `defaultYear`. A two-part numeric date (`3/11`) is day-month or month-day by the order.
 */
export function readDate(cell: string, order: DateOrder, defaultYear: number): string | undefined {
  const t = cell.trim().replace(/[ t]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\s*$/i, "").trim();
  if (t === "") return undefined;
  const num = /^(\d{1,4})[/.-](\d{1,2})(?:[/.-](\d{1,4}))?$/.exec(t);
  if (num) {
    const [a, b, c] = [num[1], num[2], num[3]];
    if (a.length === 4) return c === undefined ? undefined : realDate(Number(a), Number(b), Number(c));
    if (c === undefined) return order === "dmy" ? realDate(defaultYear, Number(b), Number(a)) : realDate(defaultYear, Number(a), Number(b));
    const y = fullYear(c.length === 4 || c.length === 2 ? c : "");
    if (order === "ymd") {
      const y0 = fullYear(a);
      return y0 === undefined ? undefined : realDate(y0, Number(b), Number(c));
    }
    if (y === undefined) return undefined;
    return order === "dmy" ? realDate(y, Number(b), Number(a)) : realDate(y, Number(a), Number(b));
  }
  // A month name.
  const tokens = t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((x) => !WEEKDAYS.has(x));
  let month: number | undefined;
  const nums: string[] = [];
  for (const tok of tokens) {
    if (MONTH_NAMES[tok] !== undefined) {
      if (month !== undefined) return undefined;
      month = MONTH_NAMES[tok];
      continue;
    }
    const n = /^(\d{1,4})(?:st|nd|rd|th)?$/.exec(tok);
    if (!n) return undefined;
    nums.push(n[1]);
  }
  if (month === undefined || nums.length < 1 || nums.length > 2) return undefined;
  if (nums.length === 1) return nums[0].length > 2 ? undefined : realDate(defaultYear, month, Number(nums[0]));
  const yi = nums.findIndex((n) => n.length === 4);
  const [dayS, yearS] = yi === 0 ? [nums[1], nums[0]] : [nums[0], nums[1]];
  if (dayS.length > 2) return undefined;
  const y = fullYear(yearS);
  return y === undefined ? undefined : realDate(y, month, Number(dayS));
}

const YES = new Set(["yes", "y", "ya", "true", "1", "x", "✓", "✔", "extra"]);
const NO = new Set(["no", "n", "tidak", "false", "0", "-"]);
/** yes from `yes`, `y`, `ya`, `true`, `1`, `x`, `✓` or `extra`; no from the usual noes; anything else is unreadable. (An empty cell is no: the caller's.) */
export function readYesNo(cell: string): boolean | undefined {
  const t = cell.trim().toLowerCase();
  if (YES.has(t)) return true;
  if (NO.has(t)) return false;
  return undefined;
}

/**
 * Hashtags split on spaces, commas and new lines, each `#` dropped. A run written without spaces (`#one#two`) is two tags: a `#` starts a tag as
 * well as being dropped from it.
 */
export function readHashtags(cell: string): string[] {
  return cell.split(/[\s,#]+/).map((s) => s.trim()).filter((s) => s !== "");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The body (BFF §63.23.2)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export const ALLOCATION_FIELDS = [
  "client", "officer", "postsPerCycle", "creativeSource", "deliveryBatch", "reportFormat", "reportDueDay", "platforms", "formats", "defaultPostTime",
] as const;
export const PLAN_FIELDS = [
  "client", "date", "time", "title", "format", "pillar", "placement", "isExtra", "angle", "objective", "keyMessage", "visualDirection", "caption",
  "onAssetText", "cta", "hashtags", "assetLinks",
] as const;
export const MAX_ALLOCATION_ROWS = 300;
export const MAX_PLAN_ROWS = 1000;
export const MAX_COLUMN_INDEX = 59;

export type ImportKind = "allocation" | "plan";

/** A merged range `[top, left, bottom, right]`, 0-based and inclusive, in the coordinates of the `rows` sent (BFF §63.23.9). */
export type Merge = [number, number, number, number];

export interface ImportBody {
  dryRun: boolean;
  headerRow: boolean;
  columns: Record<string, number>;
  rows: string[][];
  skip: Set<number>;
  /** normalized sheet name → engagement id / user id, as the person picked them (the ids are validated against the company by the controller). */
  clientMatches: Map<string, string>;
  officerMatches: Map<string, string>;
  /** The raw picks by sheet name, for the controller's `clientMatches.<sheetName>` refusals. */
  clientPicks: Array<[string, string]>;
  officerPicks: Array<[string, string]>;
  plan?: { month: string; dateOrder: DateOrder; timeZone: string; engagementId: string | null; allStories: boolean; merges: Merge[] };
}

export const MAX_MERGES = 5000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string): never => {
  throw new BadRequestException({ message: "invalid_field", field });
};
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function picksOf(v: unknown, name: string): Array<[string, string]> {
  if (v === undefined) return [];
  if (!isObject(v)) return invalid(name);
  return Object.entries(v).map(([k, id]) => {
    if (typeof id !== "string" || !UUID_RE.test(id)) return invalid(`${name}.${k}`);
    return [k, id.toLowerCase()];
  });
}

/** Whether `Intl` knows the zone. */
export function isKnownTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The plan's `merges`: at most 5,000 ranges of four integers, inside the rows sent and the 60 columns, none overlapping another (400 `invalid_field` `merges`). */
function parseMerges(v: unknown, rowCount: number): Merge[] {
  if (!Array.isArray(v) || v.length > MAX_MERGES) return invalid("merges");
  const claimed = new Set<number>();
  const out: Merge[] = [];
  for (const m of v as unknown[]) {
    if (!Array.isArray(m) || m.length !== 4 || !m.every((n) => typeof n === "number" && Number.isInteger(n))) return invalid("merges");
    const [t, l, b, r] = m as number[];
    if (t < 0 || l < 0 || t > b || l > r || b >= rowCount || r > MAX_COLUMN_INDEX) return invalid("merges");
    // An overlap is no merge Excel can hold; refusing it also bounds the work below by rows x 60 cells.
    for (let row = t; row <= b; row++) for (let col = l; col <= r; col++) {
      const key = row * 64 + col;
      if (claimed.has(key)) return invalid("merges");
      claimed.add(key);
    }
    out.push([t, l, b, r]);
  }
  return out;
}

/** Validates the body of the two writing routes, after authorization (BFF §63.23.2). 400 `invalid_field` with `field`. `today` is the report day. */
export function parseImportBody(kind: ImportKind, body: unknown, today: string): ImportBody {
  if (!isObject(body)) return invalid("body");
  if (typeof body.dryRun !== "boolean") return invalid("dryRun");
  if (typeof body.headerRow !== "boolean") return invalid("headerRow");

  const known: readonly string[] = kind === "allocation" ? ALLOCATION_FIELDS : PLAN_FIELDS;
  if (!isObject(body.columns)) return invalid("columns");
  const columns: Record<string, number> = {};
  const used = new Map<number, string>();
  for (const [name, idx] of Object.entries(body.columns)) {
    if (!known.includes(name)) return invalid(`columns.${name}`);
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx > MAX_COLUMN_INDEX) return invalid(`columns.${name}`);
    if (used.has(idx)) return invalid(`columns.${name}`);
    used.set(idx, name);
    columns[name] = idx;
  }
  // SCP-6b1 (BFF §63.23.9): one client for the whole file (`engagementId`) replaces the client column, and cannot be given beside it.
  let engagementId: string | null = null;
  let allStories = false;
  if (kind === "plan") {
    if (body.engagementId !== undefined) {
      if (typeof body.engagementId !== "string" || !UUID_RE.test(body.engagementId) || columns.client !== undefined) return invalid("engagementId");
      engagementId = body.engagementId.toLowerCase();
    }
    if (body.allStories !== undefined) {
      if (typeof body.allStories !== "boolean" || (body.allStories && columns.format !== undefined)) return invalid("allStories");
      allStories = body.allStories;
    }
  }
  for (const req of kind === "allocation" ? ["client"] : ["client", "date"]) {
    if (columns[req] === undefined && !(req === "client" && engagementId !== null)) return invalid(`columns.${req}`);
  }

  const max = kind === "allocation" ? MAX_ALLOCATION_ROWS : MAX_PLAN_ROWS;
  if (!Array.isArray(body.rows) || body.rows.length > max) return invalid("rows");
  const rows: string[][] = body.rows.map((r: unknown, i: number) => {
    if (!Array.isArray(r)) return invalid(`rows[${i}]`);
    if ((r as unknown[]).some((c) => typeof c !== "string")) return invalid(`rows[${i}]`);
    return r as string[];
  });

  const skip = new Set<number>();
  if (body.skip !== undefined) {
    if (!Array.isArray(body.skip)) return invalid("skip");
    for (const i of body.skip as unknown[]) {
      if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= rows.length) return invalid("skip");
      skip.add(i);
    }
  }

  let merges: Merge[] = [];
  if (kind === "plan" && body.merges !== undefined) merges = parseMerges(body.merges, rows.length);

  const clientPicks = picksOf(body.clientMatches, "clientMatches");
  const officerPicks = kind === "allocation" ? picksOf(body.officerMatches, "officerMatches") : [];
  const out: ImportBody = {
    dryRun: body.dryRun, headerRow: body.headerRow, columns, rows, skip,
    clientMatches: new Map(clientPicks.map(([k, v]) => [normalizeName(k), v])),
    officerMatches: new Map(officerPicks.map(([k, v]) => [normalizeName(k), v])),
    clientPicks, officerPicks,
  };

  if (kind === "plan") {
    const month = body.month;
    if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < today.slice(0, 7)) return invalid("month");
    if (typeof body.dateOrder !== "string" || !(DATE_ORDERS as readonly string[]).includes(body.dateOrder)) return invalid("dateOrder");
    if (!isKnownTimeZone(body.timeZone)) return invalid("timeZone");
    out.plan = { month, dateOrder: body.dateOrder as DateOrder, timeZone: body.timeZone, engagementId, allStories, merges };
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The answer (BFF §63.23.3)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export type Outcome = "ready" | "unchanged" | "refused" | "skipped" | "joined";
export interface RowNote { field: string; code: string }
/** `joined` (SCP-6b1) is present only when at least one plan row continued the post above, so every earlier answer reads the same. */
export interface Summary { rows: number; ready: number; unchanged: number; refused: number; skipped: number; joined?: number }
export interface UnmatchedClient { sheetName: string; rows: number[]; suggestions: Array<{ engagementId: string; clientName: string }> }
export interface UnmatchedOfficer { sheetName: string; rows: number[] }

interface RowBase { row: number; outcome: Outcome; refusals: RowNote[]; warnings: RowNote[] }

export interface ImportAnswer<R extends RowBase> {
  dryRun: boolean;
  importId: string | null;
  summary: Summary;
  unmatched: { clients: UnmatchedClient[]; officers: UnmatchedOfficer[] };
  rows: R[];
}

export function summarize(rows: ReadonlyArray<{ outcome: Outcome }>): Summary {
  const s: Summary = { rows: rows.length, ready: 0, unchanged: 0, refused: 0, skipped: 0 };
  let joined = 0;
  for (const r of rows) {
    if (r.outcome === "joined") joined += 1;
    else s[r.outcome] += 1;
  }
  if (joined > 0) s.joined = joined;
  return s;
}

/** The sheet's cells for one row as a field → trimmed text map (a missing cell is ""). Undefined for a field with no column. */
function cellsOf(row: readonly string[], columns: Record<string, number>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [field, idx] of Object.entries(columns)) out[field] = (row[idx] ?? "").trim();
  return out;
}

/** The data rows: every row, or every row after the header. */
function dataRowIndexes(body: Pick<ImportBody, "rows" | "headerRow">): number[] {
  const out: number[] = [];
  for (let i = body.headerRow ? 1 : 0; i < body.rows.length; i++) out.push(i);
  return out;
}

const emptyRow = (cells: Record<string, string | undefined>): boolean => Object.values(cells).every((v) => v === undefined || v === "");

/** Groups unmatched names: the first spelling is shown, the rows are those of every spelling that normalizes alike. */
class UnmatchedBook<T extends { sheetName: string; rows: number[] }> {
  private readonly byNorm = new Map<string, T>();
  constructor(private readonly make: (sheetName: string) => T) {}
  add(sheetName: string, row: number): T {
    const key = normalizeName(sheetName);
    let e = this.byNorm.get(key);
    if (!e) {
      e = this.make(sheetName);
      this.byNorm.set(key, e);
    }
    e.rows.push(row);
    return e;
  }
  list(): T[] {
    return [...this.byNorm.values()];
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Allocation rows (BFF §63.23.4)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface AllocationEngagement {
  engagementId: string;
  clientName: string;
  officer: { id: string; name: string } | null;
  postsPerCycle: number | null;
  creativeSource: string;
  deliveryBatch: string | null;
  reportFormat: string | null;
  reportDueDay: number | null;
  platforms: string[];
  formats: string[];
  defaultPostTime: string | null;
}
export interface Member { id: string; name: string; email: string }

export interface AllocationRowAnswer extends RowBase {
  engagementId: string | null;
  clientName: string | null;
  changes: Record<string, { from: unknown; to: unknown }>;
}

/** What apply writes for one ready row: the PATCH body of the CHANGED fields only (`officerId`, `postsPerCycle`, ...). */
export interface AllocationWrite { row: number; engagementId: string; patch: Record<string, unknown> }

/** One allocation field's cell, read and then checked by `parseAllocationPatch`. A problem is a refusal under the field; a value is a PATCH-body entry. */
function readAllocationCell(field: string, text: string): { value: unknown } | { refusal: RowNote } {
  let value: unknown;
  switch (field) {
    case "postsPerCycle": case "reportDueDay": value = readWholeNumber(text); break;
    case "creativeSource": value = readCreativeSource(text); break;
    case "deliveryBatch": value = readBatch(text); break;
    case "reportFormat": value = readReportFormat(text); break;
    case "platforms": value = readNetworks(text); break;
    case "formats": value = readFormats(text); break;
    case "defaultPostTime": value = readTime(text); break;
    default: return { refusal: { field, code: "invalid_field" } };
  }
  if (value === undefined) return { refusal: { field, code: "invalid_field" } };
  try {
    parseAllocationPatch({ [field]: value });
  } catch (e) {
    if (e instanceof BadRequestException) return { refusal: { field, code: "invalid_field" } };
    throw e;
  }
  return { value };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The allocation preview (BFF §63.23.4): every row's outcome, the names to pick, and the writes of the ready rows. Pure. */
export function previewAllocation(
  body: ImportBody, engagements: readonly AllocationEngagement[], members: readonly Member[],
): { answer: Omit<ImportAnswer<AllocationRowAnswer>, "dryRun" | "importId">; writes: AllocationWrite[] } {
  const byId = new Map(engagements.map((e) => [e.engagementId, e]));
  const clientBook = new UnmatchedBook<UnmatchedClient>((sheetName) => ({ sheetName, rows: [], suggestions: [] }));
  const officerBook = new UnmatchedBook<UnmatchedOfficer>((sheetName) => ({ sheetName, rows: [] }));
  const names = engagements.map((e) => ({ id: e.engagementId, name: e.clientName }));

  interface Draft {
    row: number; engagement: AllocationEngagement | null; key: string; refusals: RowNote[]; warnings: RowNote[];
    patch: Record<string, unknown>; officerId: string | undefined; blank: boolean;
  }
  const drafts: Draft[] = [];
  for (const row of dataRowIndexes(body)) {
    const cells = cellsOf(body.rows[row], body.columns);
    if (body.skip.has(row)) {
      drafts.push({ row, engagement: null, key: "", refusals: [], warnings: [], patch: {}, officerId: undefined, blank: false });
      continue;
    }
    const d: Draft = { row, engagement: null, key: "", refusals: [], warnings: [], patch: {}, officerId: undefined, blank: emptyRow(cells) };
    drafts.push(d);
    if (d.blank) continue;

    const clientText = cells.client ?? "";
    if (clientText === "") d.refusals.push({ field: "client", code: "missing_value" });
    else {
      const m = matchClient(clientText, names.map((n) => ({ id: n.id, clientName: n.name })), body.clientMatches);
      if (m.kind === "matched") {
        d.engagement = byId.get(m.id) ?? null;
        d.key = m.id;
        if (!d.engagement) d.refusals.push({ field: "client", code: "client_not_found" });
      } else {
        d.key = normalizeName(clientText);
        const e = clientBook.add(clientText, row);
        if (e.suggestions.length === 0) e.suggestions = suggestNames(clientText, names).map((n) => ({ engagementId: n.id, clientName: n.name }));
        d.refusals.push({ field: "client", code: m.kind === "none" ? "client_not_found" : "client_ambiguous" });
      }
    }

    for (const field of ALLOCATION_FIELDS) {
      const text = cells[field];
      if (field === "client" || text === undefined || text === "") continue;
      if (field === "officer") {
        const m = matchOfficer(text, members, body.officerMatches);
        if (m.kind === "matched") d.officerId = m.id;
        else {
          officerBook.add(text, row);
          d.refusals.push({ field: "officer", code: m.kind === "none" ? "officer_not_found" : "officer_ambiguous" });
        }
        continue;
      }
      const r = readAllocationCell(field, text);
      if ("refusal" in r) d.refusals.push(r.refusal);
      else d.patch[field] = r.value;
    }
  }

  // A client named on two rows refuses both (the unticked rows do not count).
  const seen = new Map<string, number>();
  for (const d of drafts) if (d.key !== "" && !body.skip.has(d.row)) seen.set(d.key, (seen.get(d.key) ?? 0) + 1);
  for (const d of drafts) if (d.key !== "" && !body.skip.has(d.row) && (seen.get(d.key) ?? 0) > 1) d.refusals.push({ field: "client", code: "duplicate_client" });

  const rows: AllocationRowAnswer[] = [];
  const writes: AllocationWrite[] = [];
  for (const d of drafts) {
    const base = { row: d.row, refusals: d.refusals, warnings: d.warnings, engagementId: d.engagement?.engagementId ?? null, clientName: d.engagement?.clientName ?? null };
    if (body.skip.has(d.row) || (d.blank && d.refusals.length === 0)) {
      rows.push({ ...base, outcome: "skipped", changes: {} });
      continue;
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const patch: Record<string, unknown> = {};
    const e = d.engagement;
    if (e) {
      const cur: Record<string, unknown> = {
        postsPerCycle: e.postsPerCycle, creativeSource: e.creativeSource, deliveryBatch: e.deliveryBatch, reportFormat: e.reportFormat,
        reportDueDay: e.reportDueDay, platforms: e.platforms, formats: e.formats, defaultPostTime: e.defaultPostTime,
      };
      for (const [field, to] of Object.entries(d.patch)) {
        const from = cur[field];
        const same = Array.isArray(to) ? Array.isArray(from) && sameList(from as string[], to as string[]) : from === to;
        if (same) continue;
        changes[field] = { from, to };
        patch[field] = to;
      }
      if (d.officerId !== undefined && d.officerId !== e.officer?.id) {
        const to = members.find((m) => m.id === d.officerId);
        changes.officer = { from: e.officer, to: to ? { id: to.id, name: to.name } : { id: d.officerId, name: "" } };
        patch.officerId = d.officerId;
      }
    }
    if (d.refusals.length > 0) rows.push({ ...base, outcome: "refused", changes });
    else if (Object.keys(patch).length === 0) rows.push({ ...base, outcome: "unchanged", changes: {} });
    else {
      rows.push({ ...base, outcome: "ready", changes });
      writes.push({ row: d.row, engagementId: e!.engagementId, patch });
    }
  }
  return { answer: { summary: summarize(rows), unmatched: { clients: clientBook.list(), officers: officerBook.list() }, rows }, writes };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Plan rows (BFF §63.23.5)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** A fixed namespace for the imported posts' ids. Never change it: changing it re-mints every id, and a replay would write the month twice. */
export const SHEET_IMPORT_POST_NAMESPACE = "6a1d3c52-9b07-4e48-8f2b-5c7e0d9a4b13";

/** The post's id: a uuid v5 of `tenantId|engagementId|month|date|normalized title` (BFF §63.23.5). */
export function importPostId(tenantId: string, engagementId: string, month: string, date: string, title: string): string {
  return uuidv5([tenantId, engagementId, month, date, normalizeName(title)].join("|"), SHEET_IMPORT_POST_NAMESPACE);
}

export const DEFAULT_POST_TIME = "09:00";
export const TITLE_FROM_CAPTION_MAX = 80;

/** The caption's first (non-empty) line, cut at 80 characters. */
export function titleFromCaption(caption: string): string {
  const line = caption.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  return [...line].slice(0, TITLE_FROM_CAPTION_MAX).join("").trim();
}

export interface PlanEngagement {
  engagementId: string;
  clientName: string;
  defaultPostTime: string | null;
  deliveryBatch: "A" | "B" | null;
}

const TEXT_FIELDS = ["pillar", "angle", "objective", "keyMessage", "visualDirection", "caption", "onAssetText", "cta"] as const;
export interface PlanDraft {
  row: number;
  skipped: boolean;
  blank: boolean;
  refusals: RowNote[];
  warnings: RowNote[];
  engagement: PlanEngagement | null;
  date: string | null;
  title: string | null;
  postId: string | null;
  /** The machine's `create` params (`id`, `title`, `isExtra`, and the optional `format`, `pillar`, `scheduledAt`, `placement`). */
  params: Record<string, unknown>;
  /** The extra `social_posts` columns (snake_case). */
  extra: Record<string, unknown>;
  scheduledAt: string | null;
  /** SCP-6b1: the row this one continues (a joined row is never written on its own); null for a post of its own. */
  joinedTo: number | null;
}

export interface PlanStage {
  month: string;
  drafts: PlanDraft[];
  clientBook: UnmatchedClient[];
  /** The ids the rows would write, for the controller to look up. */
  postIds: string[];
}

// ── SCP-6b1: the team's real file (BFF §63.23.9) ─────────────────────────────────────────────────────────────────────────

/** The copy fields: a slave cell in one of these never makes a row part of the post above (the caption of row 2 is the hashtags, not a new post). */
const COPY_FIELDS: ReadonlySet<string> = new Set(["caption", "onAssetText", "cta", "hashtags"]);

const PILLAR_LINE = /^\s*(?:content\s+pillar|pillar|pilar\s+konten)\s*:\s*(.*)$/i;
const ANGLE_LINE = /^\s*(?:content\s+angle|angle|sudut\s+pandang)\s*:\s*(.*)$/i;

/**
 * The angle cell as the team writes it (`Content Pillar: ...`, `Content Angle: ...`, then the message): the pillar line, the angle line and what is left,
 * trimmed. `found` is false when the cell holds neither line, which is the cell read as today.
 */
export function splitAngleCell(text: string): { found: boolean; pillar?: string; angle?: string; rest: string } {
  let pillar: string | undefined;
  let angle: string | undefined;
  const rest: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const p = PILLAR_LINE.exec(line);
    if (p && pillar === undefined) { pillar = p[1].trim(); continue; }
    const a = ANGLE_LINE.exec(line);
    if (a && angle === undefined) { angle = a[1].trim(); continue; }
    rest.push(line);
  }
  return { found: pillar !== undefined || angle !== undefined, pillar, angle, rest: rest.join("\n").trim() };
}

/** Text made only of `#words`: every whitespace-separated token starts with `#`. */
export const isHashtagsOnly = (t: string): boolean => {
  const tokens = t.trim().split(/\s+/).filter((x) => x !== "");
  return tokens.length > 0 && tokens.every((x) => x.startsWith("#"));
};

const appendText = (a: string | undefined, b: string): string => (a ? `${a}\n\n${b}` : b);

/** Applies the angle cell's lines to the row's effective text, by the precedence of BFF §63.23.9: a field mapped to its own column wins. */
function applyAngleCell(vals: Record<string, string>, columns: Record<string, number>): void {
  const source = columns.angle !== undefined ? "angle" : columns.pillar !== undefined ? "pillar" : null;
  if (!source) return;
  const sp = splitAngleCell(vals[source] ?? "");
  if (!sp.found) return;
  if (source === "pillar") vals.pillar = sp.pillar ?? "";
  else if (columns.pillar === undefined && sp.pillar !== undefined) vals.pillar = sp.pillar;
  vals.angle = sp.angle ?? "";
  if (sp.rest !== "") {
    if (columns.keyMessage === undefined) vals.keyMessage = sp.rest;
    else vals.angle = appendText(vals.angle || undefined, sp.rest);
  }
}

export interface RawAssetLink { url: string; label: string; source: "unknown"; aiNote: null }

/** Every `https://` URL of the cell as a raw asset: the label is the text before it on its line (no trailing colon). A `http://` link is not a value. */
export function readAssetLinks(cell: string): { assets: RawAssetLink[]; badScheme: boolean } {
  const assets: RawAssetLink[] = [];
  let badScheme = false;
  for (const line of cell.split(/\r?\n/)) {
    const re = /(https?:\/\/\S+)/gi;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const end = m.index + m[1].length;
      if (!/^https:\/\//i.test(m[1])) {
        badScheme = true;
        last = end;
        continue;
      }
      const label = line.slice(last, m.index).trim().replace(/:\s*$/, "").trim();
      assets.push({ url: m[1], label, source: "unknown", aiNote: null });
      last = end;
    }
  }
  return { assets, badScheme };
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FORMAT_WORD: Record<string, string> = { feed: "Feed", carousel: "Carousel", reel: "Reel", story: "Story" };
/** `Story 6 Nov`: the title a post gets when the sheet gives nothing to take one from (BFF §63.23.9). */
export function generatedTitle(format: string | undefined, date: string): string {
  return `${(format && FORMAT_WORD[format]) || "Post"} ${Number(date.slice(8, 10))} ${MONTH_ABBR[Number(date.slice(5, 7)) - 1]}`;
}

/** Row → merged-range top, for every cell below the top row of a range: key `row * 64 + column`. */
function slaveMap(merges: readonly Merge[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const [t, l, b, r] of merges) for (let row = t + 1; row <= b; row++) for (let col = l; col <= r; col++) out.set(row * 64 + col, t);
  return out;
}

export function stagePlanRows(
  body: ImportBody, a: { tenantId: string; today: string; engagements: readonly PlanEngagement[] },
): PlanStage {
  const plan = body.plan!;
  const year = Number(plan.month.slice(0, 4));
  const byId = new Map(a.engagements.map((e) => [e.engagementId, e]));
  const names = a.engagements.map((e) => ({ id: e.engagementId, name: e.clientName }));
  const book = new UnmatchedBook<UnmatchedClient>((sheetName) => ({ sheetName, rows: [], suggestions: [] }));
  const drafts: PlanDraft[] = [];

  // Merged cells (63.23.9): which rows continue the post above, which only share its date, and what the joined rows add to their post.
  const slaves = slaveMap(plan.merges);
  const slaveTop = (row: number, col: number): number | undefined => slaves.get(row * 64 + col);
  const firstData = body.headerRow ? 1 : 0;
  const original = new Map<number, Record<string, string | undefined>>();
  for (const row of dataRowIndexes(body)) original.set(row, cellsOf(body.rows[row], body.columns));
  const link = new Map<number, { kind: "joined" | "dateOnly"; top: number }>();
  const dateCol = body.columns.date;
  if (dateCol !== undefined) {
    for (const row of dataRowIndexes(body)) {
      const m = slaveTop(row, dateCol);
      if (m === undefined || m < firstData) continue;
      const withM = Object.entries(body.columns).some(([f, c]) => f !== "date" && !COPY_FIELDS.has(f) && slaveTop(row, c) === m);
      link.set(row, { kind: withM ? "joined" : "dateOnly", top: m });
    }
  }
  const effective = new Map<number, Record<string, string | undefined>>();
  for (const [row, cells] of original) effective.set(row, { ...cells });
  for (const [row, j] of link) {
    if (j.kind !== "joined" || body.skip.has(row) || body.skip.has(j.top)) continue;
    const mine = original.get(row)!;
    const top = original.get(j.top);
    if (!top || emptyRow(mine) || emptyRow(top)) continue;
    const into = effective.get(j.top)!;
    for (const [field, col] of Object.entries(body.columns)) {
      const t = mine[field] ?? "";
      if (t === "" || slaveTop(row, col) === j.top) continue;
      const target = field === "caption" && isHashtagsOnly(t) ? "hashtags" : field;
      into[target] = appendText(into[target], t);
    }
  }
  /** Generated titles taken so far, so a second one on the same client and date gets ` (2)`. */
  const generated = new Map<string, number>();

  for (const row of dataRowIndexes(body)) {
    const cells = effective.get(row)!;
    const d: PlanDraft = {
      row, skipped: body.skip.has(row), blank: false, refusals: [], warnings: [], engagement: null, date: null, title: null, postId: null,
      params: {}, extra: {}, scheduledAt: null, joinedTo: null,
    };
    drafts.push(d);
    if (d.skipped) continue;
    d.blank = emptyRow(original.get(row)!);
    if (d.blank) continue;
    const lk = link.get(row);
    if (lk?.kind === "joined") { d.joinedTo = lk.top; continue; } // never written on its own, never refused for its own cells

    const vals: Record<string, string> = {};
    for (const [k, v] of Object.entries(cells)) vals[k] = v ?? "";
    applyAngleCell(vals, body.columns);
    const text = (f: string): string => vals[f] ?? "";

    // The client: one for the whole file, or the row's own.
    if (plan.engagementId !== null) {
      d.engagement = byId.get(plan.engagementId) ?? null;
      if (!d.engagement) d.refusals.push({ field: "client", code: "client_not_found" });
    } else if (text("client") === "") d.refusals.push({ field: "client", code: "missing_value" });
    else {
      const m = matchClient(text("client"), names.map((n) => ({ id: n.id, clientName: n.name })), body.clientMatches);
      if (m.kind === "matched" && byId.has(m.id)) d.engagement = byId.get(m.id)!;
      else {
        const e = book.add(text("client"), row);
        if (e.suggestions.length === 0) e.suggestions = suggestNames(text("client"), names).map((n) => ({ engagementId: n.id, clientName: n.name }));
        d.refusals.push({ field: "client", code: m.kind === "ambiguous" ? "client_ambiguous" : "client_not_found" });
      }
    }

    // The date: the row's own, else (a merged date shared with the row above) the top row's.
    let dateText = text("date");
    if (dateText === "" && lk?.kind === "dateOnly") {
      dateText = original.get(lk.top)?.date ?? "";
      if (dateText !== "") d.warnings.push({ field: "date", code: "date_from_merged_cell" });
    }
    if (dateText === "") d.refusals.push({ field: "date", code: "missing_value" });
    else {
      const date = readDate(dateText, plan.dateOrder, year);
      if (!date) d.refusals.push({ field: "date", code: "invalid_field" });
      else {
        d.date = date;
        // One reason per date: outside the month is the problem to fix (often the date order or a missing year), so it is not also "in the past".
        if (date.slice(0, 7) !== plan.month) d.refusals.push({ field: "date", code: "date_outside_month" });
        else if (date < a.today) d.refusals.push({ field: "date", code: "date_in_past" });
      }
    }

    // The time, then the instant.
    let time: string | undefined;
    if (text("time") !== "") {
      time = readTime(text("time"));
      if (!time) d.refusals.push({ field: "time", code: "invalid_field" });
    } else if (d.engagement) {
      time = d.engagement.defaultPostTime ?? DEFAULT_POST_TIME;
      d.warnings.push({ field: "time", code: "default_time_used" });
    }
    if (d.date && time) {
      const [h, mi] = time.split(":").map(Number);
      const at = instantInTz(d.date, h, mi, plan.timeZone);
      if (at && !contentFieldProblem("scheduledAt", at)) {
        d.scheduledAt = at;
        d.params.scheduledAt = at;
      } else d.refusals.push({ field: "time", code: "invalid_field" });
    }

    // The format (before the title: a generated title names it). A tab of stories is all stories.
    let format: string | undefined;
    if (plan.allStories) {
      format = "story";
      d.params.format = format;
    } else if (text("format") !== "") {
      const v = readFormat(text("format"));
      if (v === undefined || contentFieldProblem("format", v)) d.refusals.push({ field: "format", code: "invalid_field" });
      else {
        format = v;
        d.params.format = v;
      }
    }

    // The title: the sheet's, else the first line of the caption, of the text on the design, of the call to action, else `Story 6 Nov`.
    let title = text("title");
    if (title === "") {
      const sources: Array<[string, string]> = [["caption", "title_from_caption"], ["onAssetText", "title_from_on_asset_text"], ["cta", "title_from_cta"]];
      for (const [field, code] of sources) {
        const t = titleFromCaption(text(field));
        if (t !== "") { title = t; d.warnings.push({ field: "title", code }); break; }
      }
    }
    if (title === "" && d.date) {
      const base = generatedTitle(format, d.date);
      const key = `${d.engagement?.engagementId ?? normalizeName(text("client"))}|${d.date}|${base}`;
      const n = (generated.get(key) ?? 0) + 1;
      generated.set(key, n);
      title = n > 1 ? `${base} (${n})` : base;
      d.warnings.push({ field: "title", code: "title_generated" });
    }
    if (title === "") d.refusals.push({ field: "title", code: "missing_title" });
    else if (contentFieldProblem("title", title)) d.refusals.push({ field: "title", code: "invalid_field" });
    else {
      d.title = title;
      d.params.title = title;
    }

    // isExtra, placement.
    if (text("isExtra") !== "") {
      const v = readYesNo(text("isExtra"));
      if (v === undefined) d.refusals.push({ field: "isExtra", code: "invalid_field" });
      else d.params.isExtra = v;
    } else d.params.isExtra = false;
    if (text("placement") !== "") {
      const v = readNetworks(text("placement"));
      if (v === undefined || contentFieldProblem("placement", v)) d.refusals.push({ field: "placement", code: "invalid_field" });
      else d.params.placement = v;
    }

    // The text fields: pillar goes through the machine's create, the rest are the post's starting text.
    for (const f of TEXT_FIELDS) {
      const v = text(f);
      if (v === "") continue;
      if (contentFieldProblem(f, v)) d.refusals.push({ field: f, code: "invalid_field" });
      else if (f === "pillar") d.params.pillar = v;
      else d.extra[columnOf(f)] = v;
    }
    if (text("hashtags") !== "") {
      const tags = readHashtags(text("hashtags"));
      if (tags.length === 0 || contentFieldProblem("hashtags", tags)) d.refusals.push({ field: "hashtags", code: "invalid_field" });
      else d.extra[columnOf("hashtags")] = tags;
    }
    // The links the sheet gives the post's footage and designs (SCP-6b1): each https URL is one raw asset.
    if (text("assetLinks") !== "") {
      const { assets, badScheme } = readAssetLinks(text("assetLinks"));
      if (badScheme || contentFieldProblem("rawAssets", assets)) d.refusals.push({ field: "assetLinks", code: "invalid_field" });
      else if (assets.length === 0) d.warnings.push({ field: "assetLinks", code: "asset_link_missing_url" });
      else d.extra[columnOf("rawAssets")] = assets;
    }

    if (d.engagement && d.date && d.title) {
      d.postId = importPostId(a.tenantId, d.engagement.engagementId, plan.month, d.date, d.title);
      d.params.id = d.postId;
    }
  }
  return { month: plan.month, drafts, clientBook: book.list(), postIds: drafts.flatMap((d) => (d.postId ? [d.postId] : [])) };
}

/** What the controller found: the month's cycles, the posts of those cycles, and which of the rows' ids already exist. */
export interface PlanLookups {
  /** engagement id → the live cycle of the month. */
  cycles: ReadonlyMap<string, { cycleId: string; deadline: string }>;
  /** cycle id → its live pipeline posts. */
  cyclePosts: ReadonlyMap<string, ReadonlyArray<{ id: string; title: string }>>;
  /** post id → whether it is deleted (discarded), for the ids the rows would write. */
  existing: ReadonlyMap<string, { deleted: boolean }>;
  /** The A/B pre-fill deadline for a batch (`prefillDeadline` over the company's calendar). */
  prefillFor: (batch: "A" | "B" | null) => string | null;
}

export interface PlanRowAnswer extends RowBase {
  engagementId: string | null;
  clientName: string | null;
  cycle: { cycleId: string | null; deadline: string | null; created: boolean } | null;
  post: { id: string | null; title: string | null; format: string | null; scheduledAt: string | null; isExtra: boolean; placement: string[] } | null;
  /** SCP-6b1: set on a row that continues the post of that row (outcome `joined`, or that post's `skipped` / `refused` followed). */
  joinedTo?: number;
}

/** What apply writes for one ready row. `cycle.create` is true when the month has no cycle yet (the first ready row of the client makes it). */
export interface PlanWrite {
  row: number;
  engagementId: string;
  cycle: { cycleId: string | null; deadline: string };
  params: Record<string, unknown>;
  extra: Record<string, unknown>;
}

/** The plan preview, stage two (BFF §63.23.5): the cycle each row belongs to, the posts that already exist, the warnings and each row's outcome. Pure. */
export function finishPlan(stage: PlanStage, lookups: PlanLookups): {
  answer: Omit<ImportAnswer<PlanRowAnswer>, "dryRun" | "importId">; writes: PlanWrite[];
} {
  const rows: PlanRowAnswer[] = [];
  const writes: PlanWrite[] = [];
  const takenIds = new Set<string>();
  /** The normalized titles of this import's earlier rows, per engagement, with the id of each. */
  const titlesInImport = new Map<string, Array<{ id: string; norm: string }>>();

  /** Each row's final outcome and refusals, so a joined row can follow the post it continues. */
  const finalOf = new Map<number, PlanRowAnswer>();

  for (const d of stage.drafts) {
    const e = d.engagement;
    const base = { row: d.row, refusals: d.refusals, warnings: d.warnings, engagementId: e?.engagementId ?? null, clientName: e?.clientName ?? null };
    if (d.joinedTo !== null) {
      // BFF §63.23.9: a joined row is never written on its own. It shows the post it continues, and follows that post when it is skipped or refused.
      const top = finalOf.get(d.joinedTo);
      const outcome: Outcome = top?.outcome === "skipped" ? "skipped" : top?.outcome === "refused" ? "refused" : "joined";
      const row: PlanRowAnswer = {
        row: d.row, outcome, refusals: outcome === "refused" ? [...top!.refusals] : [], warnings: [], engagementId: top?.engagementId ?? null,
        clientName: top?.clientName ?? null, cycle: null, post: null, joinedTo: d.joinedTo,
      };
      rows.push(row);
      finalOf.set(d.row, row);
      continue;
    }
    if (d.skipped || (d.blank && d.refusals.length === 0)) {
      const row: PlanRowAnswer = { ...base, outcome: "skipped", cycle: null, post: null };
      rows.push(row);
      finalOf.set(d.row, row);
      continue;
    }
    const existing = d.postId ? lookups.existing.get(d.postId) : undefined;
    // A post this import already wrote answers `unchanged` on a later replay even when its date has since passed.
    if (existing) for (let i = d.refusals.length - 1; i >= 0; i--) if (d.refusals[i].code === "date_in_past") d.refusals.splice(i, 1);
    const cyc = e ? lookups.cycles.get(e.engagementId) : undefined;
    let cycle: PlanRowAnswer["cycle"] = null;
    if (e) {
      if (cyc) cycle = { cycleId: cyc.cycleId, deadline: cyc.deadline, created: false };
      else {
        const deadline = lookups.prefillFor(e.deliveryBatch);
        cycle = { cycleId: null, deadline, created: deadline !== null };
        if (deadline === null && !existing) d.refusals.push({ field: "cycle", code: "no_cycle_deadline" });
      }
    }
    const post: PlanRowAnswer["post"] = {
      id: d.postId, title: d.title, format: typeof d.params.format === "string" ? d.params.format : null, scheduledAt: d.scheduledAt,
      isExtra: d.params.isExtra === true, placement: Array.isArray(d.params.placement) ? (d.params.placement as string[]) : [],
    };

    let outcome: Outcome;
    if (d.refusals.length > 0) outcome = "refused";
    else if (existing) {
      outcome = "unchanged";
      if (existing.deleted) d.warnings.push({ field: "post", code: "discarded_since" });
    } else if (d.postId && takenIds.has(d.postId)) {
      // The same client, date and title twice in one sheet: one post. The later row has nothing to add.
      outcome = "unchanged";
      d.warnings.push({ field: "title", code: "same_title_in_cycle" });
    } else outcome = "ready";

    if ((outcome === "ready" || outcome === "unchanged") && e && d.postId && d.title) {
      const norm = normalizeName(d.title);
      const others = [
        ...(cyc ? lookups.cyclePosts.get(cyc.cycleId) ?? [] : []).map((p) => ({ id: p.id, norm: normalizeName(p.title) })),
        ...(titlesInImport.get(e.engagementId) ?? []),
      ];
      if (outcome === "ready" && others.some((o) => o.id !== d.postId && o.norm === norm)) d.warnings.push({ field: "title", code: "same_title_in_cycle" });
      if (outcome === "ready") {
        takenIds.add(d.postId);
        titlesInImport.set(e.engagementId, [...(titlesInImport.get(e.engagementId) ?? []), { id: d.postId, norm }]);
        writes.push({ row: d.row, engagementId: e.engagementId, cycle: { cycleId: cyc?.cycleId ?? null, deadline: cycle!.deadline! }, params: d.params, extra: d.extra });
      } else takenIds.add(d.postId);
    }
    const row: PlanRowAnswer = { ...base, outcome, cycle, post };
    rows.push(row);
    finalOf.set(d.row, row);
  }
  return { answer: { summary: summarize(rows), unmatched: { clients: stage.clientBook, officers: [] }, rows }, writes };
}

/** Which engagements' cycles apply must create: the ready rows' engagements that have no cycle (one entry each, with its deadline). */
export function cyclesToCreate(writes: readonly PlanWrite[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of writes) if (w.cycle.cycleId === null && !out.has(w.engagementId)) out.set(w.engagementId, w.cycle.deadline);
  return out;
}
