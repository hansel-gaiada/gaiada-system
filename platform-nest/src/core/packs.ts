// THE ONE pack registry for the platform-nest side. The platform-ui side mirrors it (`PACK_DATA` is written
// identically in both files) and a parity test fails on drift.
//
// Packs are keyed by VERTICAL, never by a company name or id (PV-D13). Only the agency pack has
// content (PV-D3); every other vertical, and any unknown value, resolves to the generic pack.
// The `company_verticals` table (migration 202610110530_company_verticals.sql) must list exactly
// `VERTICALS` (PV-D14); the platform-nest test checks that.

// The data block. Written IDENTICALLY on both sides: the UI parity test compares this text.
// defaultModules: every company gets pm, it, invoice, clients, knowledge, automation-console (backfill
// 0024_module_backfill.sql, with `billing` renamed to `invoice` by 202608261030_rename_billing_module_to_invoice.sql).
// The agency vertical adds agency, hr, reports, assistant, exactly what the seed gives the agency
// company (src/seed/agency.ts, `ensureCompany(AGENCY_NAME, ["agency", "hr", "reports", "assistant"], ...)`).
export const PACK_DATA = {
  verticals: ["holding", "agency", "hospitality", "catering", "general"],
  verticalPack: {
    holding: "generic",
    agency: "agency",
    hospitality: "generic",
    catering: "generic",
    general: "generic",
  },
  packs: {
    agency: {
      key: "agency",
      defaultModules: ["pm", "it", "invoice", "clients", "knowledge", "automation-console", "agency", "hr", "reports", "assistant"],
      agencyRows: ["clients", "deliverables", "timesheets", "invoices", "agency", "meetings", "pipeline", "monitoring"],
      toolkitDepartments: ["web-dev", "creatives", "seo", "social-media", "gm"],
      kpis: ["revenue", "ar", "project_health", "client_health", "utilization", "pipeline"],
      vocabulary: { client: "Client", project: "Project" },
    },
    generic: {
      key: "generic",
      defaultModules: ["pm", "it", "invoice", "clients", "knowledge", "automation-console"],
      agencyRows: [],
      toolkitDepartments: [],
      kpis: ["headcount", "payroll", "ar", "ap", "approvals"],
      vocabulary: { client: "Client", project: "Project" },
    },
  },
  rowModule: { clients: "clients", invoices: "invoice", agency: "agency", monitoring: "monitoring" },
} as const;

export const VERTICALS = PACK_DATA.verticals;
export type Vertical = (typeof VERTICALS)[number];
export type AgencyRowKey = "clients" | "deliverables" | "timesheets" | "invoices" | "agency" | "meetings" | "pipeline" | "monitoring";
export type PackKey = "agency" | "generic";

export interface Pack {
  key: PackKey;
  /** Module keys switched on when a NEW company of this vertical is created (PV-D17). */
  defaultModules: readonly string[];
  /** Staff-menu rows this pack turns on. */
  agencyRows: readonly AgencyRowKey[];
  /** Department slugs that get a bespoke toolkit. */
  toolkitDepartments: readonly string[];
  /** Dashboard KPI keys. */
  kpis: readonly string[];
  vocabulary: { client: string; project: string };
}

export const PACKS: Record<PackKey, Pack> = PACK_DATA.packs;
export const VERTICAL_PACK: Record<Vertical, PackKey> = PACK_DATA.verticalPack;
/** Rows that also have a module key; rows absent here are hidden by vertical only. */
export const ROW_MODULE: Partial<Record<AgencyRowKey, string>> = PACK_DATA.rowModule;

/** Unknown, null or undefined vertical resolves to the generic pack. */
export function packFor(vertical: string | null | undefined): Pack {
  if (vertical && Object.prototype.hasOwnProperty.call(VERTICAL_PACK, vertical)) {
    return PACKS[VERTICAL_PACK[vertical as Vertical]];
  }
  return PACKS.generic;
}
