import "server-only";
// TEMP DEMO MODE: stateful in-memory store for a department's assistant guidance (AIP-13b, BFF §65), after `demoNotices.ts` (the same people,
// the same placement). Routed from `demoFixtures.getDemoResponse`, so the guidance page works with no backend. Module-level state lasts for the
// dev-server process. It models the rules the UI depends on: the company tier (`demo-hansel` the admin, `demo-owner`) and the head of a unit read and
// write any unit / their own; everyone else is 403 (before anything says whether the unit exists); an unknown unit is 404 `department_not_found`; a
// text is trimmed, 1 to 1,000 code points stores it, empty deletes it (the default is back), more is a 400 naming `body`. `contextEnabled` is false in the
// demo company, which shows the "not in use yet" note. The preview is built the way the server builds it: the context line, a blank line,
// `Department guidance:` and the effective text.
interface DemoResult { status: number; json: unknown }
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const err = (status: number, error: string, field?: string): DemoResult => ({ status, json: field ? { error, field } : { error } });

const TENANT = "co-agency";
const UNITS: Record<string, { name: string; key: string }> = {
  "dept-1": { name: "Web Dev", key: "web-dev" }, "dept-2": { name: "Creatives", key: "creatives" }, "dept-3": { name: "SEO", key: "seo" },
  "dept-4": { name: "Social Media", key: "social-media" }, "dept-5": { name: "GM", key: "gm" }, "dept-6": { name: "HR", key: "hr" },
  "dept-7": { name: "Finance", key: "finance" }, "dept-8": { name: "IT", key: "it" },
};
const DEFAULTS: Record<string, string> = {
  "web-dev": "Web Dev takes client requirements to a shipped build. Common words: briefing, request, board, deliverable, pipeline, build, run, monitoring.",
  seo: "SEO is search marketing: organic search, AI answers and paid search. Common words: keyword, ranking, audit, content brief, traffic, client report.",
};
const COMPANY_TIER = new Set(["demo-hansel", "demo-owner"]);
const LED: Record<string, string[]> = { "u-webhead": ["dept-1"], "dept-manager": ["dept-3"] };
const NAMES: Record<string, string> = { "demo-hansel": "Clement Hansel", "demo-owner": "The Owner", "u-webhead": "Ketut Arta", "dept-manager": "Wayan Sari" };
const MAX = 1000;

interface Row { body: string; updatedAt: string; updatedBy: string }
let rows = new Map<string, Row>();
export function resetAssistantGuidanceDemo(): void { rows = new Map(); }

const mayTouch = (userId: string, unit: string) => COMPANY_TIER.has(userId) || (LED[userId] ?? []).includes(unit);

function view(unit: string): unknown {
  const dept = UNITS[unit];
  const def = DEFAULTS[dept.key] ?? null;
  const row = rows.get(unit) ?? null;
  const custom = row ? row.body : null;
  const effective = custom ?? def;
  const line = `You are helping someone in the ${dept.name} department.`;
  return {
    unitNodeId: unit, department: dept, custom, defaultText: def, effective,
    updatedAt: row ? row.updatedAt : null,
    updatedBy: row ? { id: row.updatedBy, name: NAMES[row.updatedBy] ?? "" } : null,
    preview: effective ? `${line}\n\nDepartment guidance:\n${effective}` : line,
    contextEnabled: false,
  };
}

export function assistantGuidanceDemo(method: string, p: string, body: string | undefined, userId: string): DemoResult | null {
  const m = p.match(/^\/api\/([^/]+)\/departments\/([^/]+)\/assistant-preamble$/);
  if (!m) return null;
  const tenant = m[1];
  const unit = decodeURIComponent(m[2]);
  const verb = method.toUpperCase();
  if (verb !== "GET" && verb !== "PUT") return err(404, "not_found");
  // Authorization before anything says whether the unit exists (the order of checks, §65.2).
  if (tenant !== TENANT || !mayTouch(userId, unit)) return err(403, "Forbidden");
  if (!UNITS[unit]) return err(404, "department_not_found", "unitNodeId");
  if (verb === "GET") return ok(view(unit));
  let parsed: unknown;
  try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = undefined; }
  const o = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  if (!o || typeof o.body !== "string") return err(400, "body is required and must be a string", "body");
  const text = o.body.replace(/\r\n?/g, "\n").trim();
  const n = Array.from(text).length;
  if (n > MAX) return err(400, `body must be at most ${MAX} characters`, "body");
  if (n === 0) rows.delete(unit);
  else rows.set(unit, { body: text, updatedAt: new Date().toISOString(), updatedBy: userId });
  return ok(view(unit));
}
