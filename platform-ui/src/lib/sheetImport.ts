// SCP-6a — the one-off sheet import's types and pure helpers (BFF §63.23): the fields of each kind, the header aliases the team's sheet uses and the
// guess that maps a header row onto them, the CSV template, the request body, the answers' defensive parsers and the words for every row code.
// No server-only import, so the wizard (a client component) imports the values; the three routes are called from `lib/socialImportActions.ts`.
//
// THE RULES ARE THE SERVER'S. Which cell is a client, how a date or a time is read, what a row refuses for: all of it is platform-nest's
// (`modules/social/pipeline/sheet-import.ts`). This file only maps columns, draws what the server answered and words its codes.

export type ImportKind = "allocation" | "plan";
export type DateOrder = "dmy" | "mdy" | "ymd";
export type Outcome = "ready" | "unchanged" | "refused" | "skipped";

/** BFF §63.23.1 and §63.23.2: the limits the routes enforce, mirrored so the page says so before it sends. */
export const MAX_SHEET_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS: Readonly<Record<ImportKind, number>> = { allocation: 300, plan: 1000 };

export const IMPORT_KIND_LABEL: Readonly<Record<ImportKind, string>> = { allocation: "The allocation", plan: "A month's plan" };

export const DATE_ORDER_LABEL: Readonly<Record<DateOrder, string>> = {
  dmy: "Day, month, year (31/12/2026)", mdy: "Month, day, year (12/31/2026)", ymd: "Year, month, day (2026-12-31)",
};

/** BFF §63.23.6's six steps: what the wizard walks through, and what the page explains where the wizard is not (DEMO_MODE, or no right to import). */
export const IMPORT_STEPS: ReadonlyArray<{ key: string; title: string; blurb: string }> = [
  { key: "what", title: "What", blurb: "Choose what the sheet holds: the allocation (one row per client), or a month's plan (one row per post)." },
  { key: "sheet", title: "The sheet", blurb: "Upload an .xlsx or .csv file, or paste rows copied from Google Sheets or Excel. Pick the tab, and say whether the first row is the header." },
  { key: "columns", title: "Columns", blurb: "Say which column is which field. The page guesses from the header row, and you can change every guess. For a plan, choose the date order." },
  { key: "names", title: "Names", blurb: "Pick the client, or the officer, for any name the ERP could not match on its own. A client is never created here: its engagement is opened in the ERP first." },
  { key: "preview", title: "Preview", blurb: "See what every row would do and why, before anything is written. Untick a row to skip it." },
  { key: "import", title: "Import", blurb: "Write the rows in one go. If any row you kept is refused, nothing is written. Then follow the links to check the result." },
];

/** The words every importer of this file shows for a person who may not import. */
export const IMPORT_REFUSAL_REASON = "Only the Social Media head, the GM, the owner and the superadmin can import from a sheet.";

// ── The fields ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FieldSpec {
  /** The key the route reads in `columns` (BFF §63.23.4, §63.23.5). */
  key: string;
  label: string;
  required: boolean;
  /** What a cell of this column holds, in a sentence. */
  hint: string;
  /** The header the CSV template carries; it guesses back to this field (the test pins it). */
  header: string;
}

const f = (key: string, label: string, header: string, hint: string, required = false): FieldSpec => ({ key, label, header, hint, required });

/** BFF §63.23.4, in the contract's order. */
export const ALLOCATION_FIELDS: readonly FieldSpec[] = [
  f("client", "Client", "Client", "The client's name, as the ERP knows it.", true),
  f("officer", "Officer", "Officer", "The person who looks after the client: their name or email."),
  f("postsPerCycle", "Posts per month", "Posts per month", "A whole number, such as 12."),
  f("creativeSource", "Creative source", "Creative source", "Creatives team, or In team."),
  f("deliveryBatch", "Delivery batch", "Batch", "A or B."),
  f("reportFormat", "Report format", "Report format", "Email or meeting."),
  f("reportDueDay", "Report due day", "Report due day", "The day of the month the report is due."),
  f("platforms", "Platforms", "Platforms", "Several allowed, such as IG, TikTok, LinkedIn."),
  f("formats", "Formats", "Formats", "Several allowed: feed, carousel, reel, story."),
  f("defaultPostTime", "Default post time", "Default post time", "Such as 09:00 or 7:30 pm."),
];

/** BFF §63.23.5, in the contract's order. */
export const PLAN_FIELDS: readonly FieldSpec[] = [
  f("client", "Client", "Client", "The client's name, as the ERP knows it.", true),
  f("date", "Posting date", "Date", "The day the post goes out, read in the date order you choose.", true),
  f("time", "Posting time", "Time", "Such as 09:00 or 7:30 pm. Empty takes the client's default time."),
  f("title", "Title", "Title", "The topic or idea. Empty takes the caption's first line."),
  f("format", "Format", "Format", "Feed, carousel, reel or story."),
  f("pillar", "Content pillar", "Pillar", "The pillar from the client's brand book."),
  f("placement", "Platforms", "Platform", "Where it goes out: IG, TikTok, LinkedIn and so on."),
  f("isExtra", "Extra post", "Extra", "Yes for an extra post, outside the month's target."),
  f("angle", "Angle", "Angle", "The planning angle."),
  f("objective", "Objective", "Objective", "What the post is for."),
  f("keyMessage", "Key message", "Key message", "The one thing it says."),
  f("visualDirection", "Visual direction", "Visual direction", "The brief for the designer."),
  f("caption", "Caption", "Caption", "The post's copy. It is the post's starting text."),
  f("onAssetText", "Text on the design", "Text on design", "The words that sit on the image."),
  f("cta", "Call to action", "CTA", "The call to action."),
  f("hashtags", "Hashtags", "Hashtags", "Split on spaces, commas and new lines."),
];

export const fieldsFor = (kind: ImportKind): readonly FieldSpec[] => (kind === "allocation" ? ALLOCATION_FIELDS : PLAN_FIELDS);

export const fieldLabel = (kind: ImportKind, key: string): string => fieldsFor(kind).find((x) => x.key === key)?.label ?? key;

// ── The header guess ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Lower case, accents removed, punctuation turned into spaces, spaces collapsed: the rule `normalizeName` applies on the server (BFF §63.23.2). */
export function normalizeHeader(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * The names the team's sheet uses for each field, in English and Indonesian. A header matches a field when it equals one of these after
 * `normalizeHeader`, or (second pass) holds one as whole words. Add a spelling here and nowhere else.
 */
export const HEADER_ALIASES: Readonly<Record<ImportKind, Readonly<Record<string, readonly string[]>>>> = {
  allocation: {
    client: ["client", "client name", "klien", "nama klien", "brand", "brand name", "account", "customer"],
    officer: ["officer", "social media officer", "smm", "pic", "penanggung jawab", "handler", "managed by"],
    postsPerCycle: ["posts per month", "post per month", "post per bulan", "jumlah post", "jumlah posting", "quota", "kuota", "monthly posts", "posts"],
    creativeSource: ["creative source", "sumber kreatif", "sumber desain", "designer", "design by", "creative"],
    deliveryBatch: ["batch", "delivery batch", "batch delivery"],
    reportFormat: ["report format", "format laporan", "report type", "reporting format"],
    reportDueDay: ["report due", "report due day", "report day", "report due date", "tanggal laporan", "tgl laporan", "due day"],
    platforms: ["platforms", "platform", "channels", "channel", "networks", "network"],
    formats: ["formats", "content formats", "content format", "jenis konten", "post formats"],
    defaultPostTime: ["default time", "default post time", "default posting time", "jam posting", "jam default", "posting time"],
  },
  plan: {
    client: ["client", "client name", "klien", "nama klien", "brand", "brand name", "account", "customer"],
    date: ["date", "tanggal", "tgl", "posting date", "post date", "publish date", "tanggal posting", "tgl posting", "schedule date"],
    time: ["time", "jam", "waktu", "posting time", "post time", "jam posting", "publish time"],
    title: ["title", "topic", "topik", "judul", "idea", "ide", "content idea", "ide konten", "content"],
    format: ["format", "type", "jenis", "tipe", "content type", "content format", "post type", "jenis konten"],
    pillar: ["pillar", "pilar", "content pillar", "pilar konten"],
    placement: ["platform", "platforms", "placement", "channel", "channels", "network", "networks"],
    isExtra: ["extra", "tambahan", "extra post", "post tambahan"],
    angle: ["angle", "sudut pandang"],
    objective: ["objective", "tujuan", "goal", "objective post"],
    keyMessage: ["key message", "pesan utama", "pesan kunci", "main message"],
    visualDirection: ["visual direction", "brief visual", "visual brief", "referensi", "reference", "visual reference", "visual"],
    caption: ["caption", "copy", "copywriting", "caption copy", "teks caption"],
    onAssetText: ["on asset text", "text on asset", "text on design", "teks desain", "teks di desain", "teks pada desain", "headline", "design text"],
    cta: ["cta", "call to action"],
    hashtags: ["hashtags", "hashtag", "tagar", "tags"],
  },
};

const NORMALIZED: Record<ImportKind, Array<{ field: string; aliases: string[] }>> = {
  allocation: [], plan: [],
};
for (const kind of ["allocation", "plan"] as const) {
  NORMALIZED[kind] = fieldsFor(kind).map((x) => ({ field: x.key, aliases: (HEADER_ALIASES[kind][x.key] ?? []).map(normalizeHeader) }));
}

const containsWords = (header: string, alias: string): boolean => ` ${header} `.includes(` ${alias} `);

/**
 * Guesses which column is which field from a header row. Pass 1 takes exact matches; pass 2 takes a header that holds an alias as whole words (the
 * longest alias first), for fields and columns still free. A column goes to one field only, because the route refuses a column given to two.
 * Answers `{ [field]: column index }` for the fields it found.
 */
export function guessColumns(kind: ImportKind, headers: readonly string[]): Record<string, number> {
  const heads = headers.map(normalizeHeader);
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const { field, aliases } of NORMALIZED[kind]) {
    const i = heads.findIndex((h, c) => h !== "" && !used.has(c) && aliases.includes(h));
    if (i >= 0) { out[field] = i; used.add(i); }
  }
  for (const { field, aliases } of NORMALIZED[kind]) {
    if (field in out) continue;
    let best: { col: number; len: number } | null = null;
    heads.forEach((h, c) => {
      if (h === "" || used.has(c)) return;
      for (const a of aliases) if (a.length >= 3 && containsWords(h, a) && (!best || a.length > best.len)) best = { col: c, len: a.length };
    });
    if (best) { out[field] = (best as { col: number }).col; used.add((best as { col: number }).col); }
  }
  return out;
}

/** "A", "B", ... "Z", "AA": the spreadsheet's own name for a 0-based column. */
export function columnLetter(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ── The template ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const templateHeaders = (kind: ImportKind): string[] => fieldsFor(kind).map((x) => x.header);

const csvCell = (s: string): string => (/[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The CSV a person can fill in: one header row, the fields in the contract's order. */
export const templateCsv = (kind: ImportKind): string => `${templateHeaders(kind).map(csvCell).join(",")}\r\n`;

export const templateFilename = (kind: ImportKind): string => `social-${kind}-import-template.csv`;

// ── Rows of the sheet ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SheetTab { name: string; rows: string[][] }

/** The rows with no cell holding anything: the wizard unticks them, so a gap in the sheet does not refuse the whole import. */
export function blankRowIndexes(rows: readonly (readonly string[])[]): number[] {
  const out: number[] = [];
  rows.forEach((r, i) => { if (r.every((c) => c.trim() === "")) out.push(i); });
  return out;
}

/** The fields given to one column twice: the route refuses that (400 `invalid_field`), so the wizard says so first. */
export function duplicateColumns(mapping: Readonly<Record<string, string>>): Array<{ column: number; fields: string[] }> {
  const byCol = new Map<number, string[]>();
  for (const [field, v] of Object.entries(mapping)) {
    if (v === "") continue;
    const c = Number(v);
    byCol.set(c, [...(byCol.get(c) ?? []), field]);
  }
  return [...byCol.entries()].filter(([, fs]) => fs.length > 1).map(([column, fields]) => ({ column, fields }));
}

// ── The request ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** BFF §63.23.2. `month`, `dateOrder` and `timeZone` are the plan's alone. */
export interface ImportBody {
  dryRun: boolean;
  headerRow: boolean;
  columns: Record<string, number>;
  rows: string[][];
  skip?: number[];
  clientMatches?: Record<string, string>;
  officerMatches?: Record<string, string>;
  month?: string;
  dateOrder?: DateOrder;
  timeZone?: string;
}

export interface ImportDraft {
  kind: ImportKind;
  rows: string[][];
  headerRow: boolean;
  mapping: Readonly<Record<string, string>>;
  skip: ReadonlySet<number>;
  clientMatches: Readonly<Record<string, string>>;
  officerMatches: Readonly<Record<string, string>>;
  month: string;
  dateOrder: DateOrder;
  timeZone: string;
}

const nonEmpty = (o: Readonly<Record<string, string>>): Record<string, string> | undefined => {
  const e = Object.entries(o).filter(([, v]) => v !== "");
  return e.length ? Object.fromEntries(e) : undefined;
};

/** The body of `POST import/allocation` or `import/plan`. A field left on "not in my sheet" is left out; the empty picks are left out. */
export function buildImportBody(d: ImportDraft, dryRun: boolean): ImportBody {
  const columns: Record<string, number> = {};
  for (const x of fieldsFor(d.kind)) {
    const v = d.mapping[x.key];
    if (v !== undefined && v !== "") columns[x.key] = Number(v);
  }
  const skip = [...d.skip].sort((a, b) => a - b);
  return {
    dryRun, headerRow: d.headerRow, columns, rows: d.rows,
    ...(skip.length ? { skip } : {}),
    ...(nonEmpty(d.clientMatches) ? { clientMatches: nonEmpty(d.clientMatches) } : {}),
    ...(d.kind === "allocation" && nonEmpty(d.officerMatches) ? { officerMatches: nonEmpty(d.officerMatches) } : {}),
    ...(d.kind === "plan" ? { month: d.month, dateOrder: d.dateOrder, timeZone: d.timeZone } : {}),
  };
}

// ── The answers ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RowIssue { field: string; code: string }

export interface ImportRow {
  /** The index into `rows`: the sheet's row number less one. */
  row: number;
  outcome: Outcome;
  refusals: RowIssue[];
  warnings: RowIssue[];
  engagementId: string | null;
  clientName: string | null;
  /** An allocation row: each field it would change. */
  changes: Record<string, { from: unknown; to: unknown }> | null;
  /** A plan row: the cycle it lands in, and the post. */
  cycle: { cycleId: string | null; deadline: string | null; created: boolean } | null;
  post: { id: string | null; title: string | null; format: string | null; scheduledAt: string | null; isExtra: boolean; placement: string[] } | null;
}

export interface UnmatchedClient { sheetName: string; rows: number[]; suggestions: Array<{ engagementId: string; clientName: string }> }
export interface UnmatchedOfficer { sheetName: string; rows: number[] }

export interface ImportAnswer {
  dryRun: boolean;
  importId: string | null;
  summary: { rows: number; ready: number; unchanged: number; refused: number; skipped: number };
  unmatched: { clients: UnmatchedClient[]; officers: UnmatchedOfficer[] };
  rows: ImportRow[];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const OUTCOMES: readonly string[] = ["ready", "unchanged", "refused", "skipped"];

/** `POST import/parse`'s answer. Throws on a body that is not one (the action turns that into a refusal the page words). */
export function asParseAnswer(raw: unknown): { tabs: SheetTab[] } {
  if (!isObj(raw) || !Array.isArray(raw.tabs)) throw new Error("parse: not a list of tabs");
  const tabs: SheetTab[] = [];
  for (const t of raw.tabs) {
    if (!isObj(t) || !Array.isArray(t.rows)) continue;
    const rows = t.rows.filter(Array.isArray).map((r: unknown[]) => r.map((c) => (typeof c === "string" ? c : c == null ? "" : String(c))));
    tabs.push({ name: str(t.name) ?? `Tab ${tabs.length + 1}`, rows });
  }
  return { tabs };
}

const issues = (v: unknown): RowIssue[] =>
  (Array.isArray(v) ? v : []).filter(isObj).filter((x) => typeof x.code === "string").map((x) => ({ field: str(x.field) ?? "", code: x.code as string }));

function asImportRow(raw: unknown): ImportRow | null {
  if (!isObj(raw) || num(raw.row) === null || typeof raw.outcome !== "string" || !OUTCOMES.includes(raw.outcome)) return null;
  const cycle = isObj(raw.cycle) ? { cycleId: str(raw.cycle.cycleId), deadline: str(raw.cycle.deadline), created: raw.cycle.created === true } : null;
  const p = isObj(raw.post) ? raw.post : null;
  const changes: Record<string, { from: unknown; to: unknown }> | null = isObj(raw.changes)
    ? Object.fromEntries(Object.entries(raw.changes).filter(([, v]) => isObj(v)).map(([k, v]) => [k, { from: (v as Record<string, unknown>).from ?? null, to: (v as Record<string, unknown>).to ?? null }]))
    : null;
  return {
    row: raw.row as number, outcome: raw.outcome as Outcome, refusals: issues(raw.refusals), warnings: issues(raw.warnings),
    engagementId: str(raw.engagementId), clientName: str(raw.clientName), changes, cycle,
    post: p ? {
      id: str(p.id), title: str(p.title), format: str(p.format), scheduledAt: str(p.scheduledAt), isExtra: p.isExtra === true,
      placement: Array.isArray(p.placement) ? strings(p.placement) : (str(p.placement) ? [p.placement as string] : []),
    } : null,
  };
}

/** The preview's and the apply's answer (BFF §63.23.3), also the 409's `detail`. Throws on a body that is not one. */
export function asImportAnswer(raw: unknown): ImportAnswer {
  if (!isObj(raw) || !Array.isArray(raw.rows)) throw new Error("import: not an answer");
  const rows = raw.rows.map(asImportRow).filter((r): r is ImportRow => r !== null);
  const s = isObj(raw.summary) ? raw.summary : {};
  const u = isObj(raw.unmatched) ? raw.unmatched : {};
  const clients: UnmatchedClient[] = (Array.isArray(u.clients) ? u.clients : []).filter(isObj).filter((c) => typeof c.sheetName === "string").map((c) => ({
    sheetName: c.sheetName as string, rows: nums(c.rows),
    suggestions: (Array.isArray(c.suggestions) ? c.suggestions : []).filter(isObj)
      .filter((x) => typeof x.engagementId === "string").map((x) => ({ engagementId: x.engagementId as string, clientName: str(x.clientName) ?? "" })),
  }));
  const officers: UnmatchedOfficer[] = (Array.isArray(u.officers) ? u.officers : []).filter(isObj).filter((o) => typeof o.sheetName === "string")
    .map((o) => ({ sheetName: o.sheetName as string, rows: nums(o.rows) }));
  const count = (o: Outcome): number => rows.filter((r) => r.outcome === o).length;
  return {
    dryRun: raw.dryRun === true, importId: str(raw.importId),
    summary: {
      rows: num(s.rows) ?? rows.length, ready: num(s.ready) ?? count("ready"), unchanged: num(s.unchanged) ?? count("unchanged"),
      refused: num(s.refused) ?? count("refused"), skipped: num(s.skipped) ?? count("skipped"),
    },
    unmatched: { clients, officers }, rows,
  };
}

// ── The words ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const OUTCOME_LABEL: Readonly<Record<Outcome, string>> = {
  ready: "Ready", unchanged: "Already there", refused: "Refused", skipped: "Skipped",
};

/** BFF §63.23.3's row codes, each as a sentence. `field` is the field's label, when the code names one. */
export function rowCodeText(code: string, field?: string): string {
  const of = field ? ` in ${field}` : "";
  switch (code) {
    // refusals
    case "missing_value": return field ? `${field} is empty, and this row needs it.` : "A value this row needs is empty.";
    case "invalid_field": return field ? `${field} holds a value the ERP cannot read.` : "A value cannot be read.";
    case "client_not_found": return "No open client has this name. Pick the client in the names step, or open its engagement in the ERP first.";
    case "client_ambiguous": return "More than one open engagement matches this client. Pick the right one in the names step.";
    case "officer_not_found": return "No active team member has this name or email. Pick the person in the names step.";
    case "officer_ambiguous": return "More than one team member matches this officer. Pick the right one in the names step.";
    case "duplicate_client": return "This client is on more than one row of the sheet. Untick all but one.";
    case "date_outside_month": return "The date is outside the month you chose. Check the date order in the columns step.";
    case "date_in_past": return "The date has already passed.";
    case "missing_title": return "There is no title, and no caption to take one from.";
    case "no_cycle_deadline": return "This client has no deadline for the month and no batch to work one out from. Set its batch in the Allocation, or its deadline in Settings, first.";
    // warnings
    case "title_from_caption": return "There is no title, so the first line of the caption is used.";
    case "default_time_used": return "There is no time, so the client's default time (or 09:00) is used.";
    case "same_title_in_cycle": return "Another post of this month has the same title.";
    case "discarded_since": return "This post was imported before and discarded since. It is not brought back.";
    default: return `${code}${of}`;
  }
}

/** The sentence for a refusal of one of the three routes (the token stays the contract's; this is only the words). */
export function importRefusalText(code: string, field?: string): string {
  switch (code) {
    case "not_a_social_approver": return IMPORT_REFUSAL_REASON;
    case "sheet_too_large": {
      const what = field === "tabs" ? "more than 20 tabs" : field === "rows" ? "more than 2,000 rows in a tab" : field === "columns" ? "more than 60 columns" : field === "cell" ? "a cell of more than 5,000 characters" : field === "file" ? "more than 32 MB of data once unpacked" : "too much";
      return `The sheet has ${what}. Cut it down and try again.`;
    }
    case "unreadable_sheet": return "The file could not be opened as a spreadsheet. Save it as .xlsx or .csv and try again.";
    case "import_rows_refused": return "Some rows are refused, so nothing was written. Fix them, or untick them, and import again.";
    case "invalid_field": {
      if (field === "contentBase64") return "The file is not a valid upload, or it is over 2 MB.";
      if (field === "filename") return "Upload an .xlsx or .csv file.";
      if (field === "text") return "The pasted text is over 2 MB.";
      if (field === "body") return "Give a file or pasted text, not both and not neither.";
      if (field === "month") return "The month must be this month or later.";
      if (field === "timeZone") return "The browser's time zone is not one the ERP knows.";
      if (field === "dateOrder") return "The date order is not one the ERP knows.";
      if (field === "rows") return "There are more rows than one import takes. Split the sheet.";
      if (field && /^columns\b/.test(field)) return "The columns are not valid: a required field is missing, or one column is given to two fields.";
      if (field && /^clientMatches\./.test(field)) return "A client you picked is not an open engagement of this company any more. Reload and pick again.";
      if (field && /^officerMatches\./.test(field)) return "An officer you picked is not an active team member any more. Reload and pick again.";
      if (field && /^skip\b/.test(field)) return "A row you unticked is not in the sheet. Reload and try again.";
      return field ? `${field} is not valid.` : "A value is not valid.";
    }
    case "session_expired": return "Session expired — sign in again.";
    default: return code;
  }
}

/** One cell of the preview: a value as a short phrase. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "none";
  if (Array.isArray(v)) return v.length ? v.map(valueText).join(", ") : "none";
  if (isObj(v)) return str(v.name) ?? str(v.clientName) ?? str(v.id) ?? "set";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

/** The text for a plan row's scheduled instant, in the zone it was read in. */
export function scheduledText(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(d);
  } catch {
    return iso;
  }
}
