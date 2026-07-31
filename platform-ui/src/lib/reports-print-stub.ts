import "server-only";
// ⚠ TEST FIXTURE — NOT PART OF THE REAL CONTRACT. ⚠
//
// TR-21 (senior-be, platform-nest: one-shot `jobToken` minting +
// `GET /internal/reports/print-payload/:jobToken`) is a separate seat's ticket — this ticket
// (TR-20) is frontend-only and must not build or depend on that backend running. TR-21 landed
// concurrently with this one (verified by reading `print-payload.controller.ts` directly — see
// `reports-print-data.ts`'s contract note), but exercising this route against a REAL running
// platform-nest + Redis instance was deliberately not attempted here, to avoid touching a
// concurrently-modified backend working tree. This file exists so the print route
// (`app/print/reports/[jobToken]/page.tsx`) can still be rendered, screenshotted, and turned into
// an actual PDF via Playwright without that live dependency, per the ticket's own instruction
// ("You may need a local stub to exercise rendering; if so, make it obviously a test fixture and
// say so").
//
// Reached ONLY from `reports-print-data.ts::getPrintPayload` when `process.env.PRINT_STUB === "1"`
// — off (and therefore inert) in every normal dev/build/prod invocation. It deliberately reuses
// `demoReports.ts`'s already-tested `reportsDemo` builder rather than hand-rolling a second set of
// fixture data (the exact mistake TR-37/TR-17's landing notes warn about: a stand-in for another
// module's data, written from assumption rather than from that module's own code, silently drifts).
// A handful of fixed jobTokens map to a handful of grain × sealed/unsealed combinations; any other
// token 404s (`PrintTokenError "not_found"`) — same as a token TR-21 never minted.
import { reportsDemo } from "./demoReports";
import type { PrintPayload } from "./reports-print-data";
import { PrintTokenError } from "./reports-print-data";
import type { ReportDocument } from "./reports";

const TENANT_ID = "co-agency";
const ELEVATED_USER_ID = "demo-hansel"; // group_executive + platform_admin in demoFixtures — every grain/scopeRef is readable

function isoDateNMonthsAgoStart(n: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}
function currentMonthStart(): string {
  return isoDateNMonthsAgoStart(0);
}

function buildDoc(grain: "person" | "project" | "department" | "company", scopeRef: string, monthStart: string): ReportDocument {
  const params = new URLSearchParams({ grain, scopeRef, periodKind: "month", start: monthStart });
  const result = reportsDemo("GET", `/api/${TENANT_ID}/reports/document`, params, undefined, ELEVATED_USER_ID);
  if (!result || result.status !== 200) {
    // Would only happen if demoReports.ts's own validation rejects a shape this file controls —
    // a bug in the stub, not something a caller can hit, so failing loudly here (rather than
    // laundering it into a PrintTokenError) is correct.
    throw new Error(`reports-print-stub: fixture build failed unexpectedly (${JSON.stringify(result)})`);
  }
  return result.json as ReportDocument;
}

// month two calendar months back from "today" is ALWAYS sealed under demoReports.ts's own rule
// (`sealed = periodKind === "month" && end < currentMonthStart`) no matter when this runs.
const SEALED_MONTH_START = isoDateNMonthsAgoStart(2);
const LIVE_MONTH_START = currentMonthStart();

const FIXTURES: Record<string, () => PrintPayload> = {
  "stub-person-unsealed": () => ({ document: buildDoc("person", "gede-ic", LIVE_MONTH_START) }),
  "stub-person-sealed": () => {
    const document = buildDoc("person", "gede-ic", SEALED_MONTH_START);
    return { document, sealHash: "deadbeef1234cafefeedface5678" };
  },
  "stub-project-unsealed": () => ({ document: buildDoc("project", "p-web-1", LIVE_MONTH_START) }),
  "stub-department-unsealed": () => ({ document: buildDoc("department", "dept-1", LIVE_MONTH_START) }),
  "stub-company-unsealed": () => ({ document: buildDoc("company", TENANT_ID, LIVE_MONTH_START) }),
  "stub-company-sealed": () => {
    const document = buildDoc("company", TENANT_ID, SEALED_MONTH_START);
    return { document, sealHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4" };
  },
};

export async function getStubPrintPayload(jobToken: string): Promise<PrintPayload> {
  const build = FIXTURES[jobToken];
  if (!build) {
    throw new PrintTokenError("not_found", `PRINT_STUB: no fixture registered for token "${jobToken}"`);
  }
  return Promise.resolve(build());
}
