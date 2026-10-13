// PV5-08 — the Documents list's merge and shape, with no database (the DB suite is client-documents.db.test.ts).
//   * newest first across the three kinds, a stable tie-break, the staff flag kept on staff rows and stripped for the portal;
//   * each query gets ITS OWN parameters (Postgres refuses a statement given a parameter it never references);
//   * the SQL for each kind names the stored-file rules (sealed copy first, issued invoices only, signed contracts only);
//   * the two controllers take their WHERE from portal-visibility.ts and write no row-visibility literal of their own.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { contractDocumentsSql, invoiceDocumentsSql, loadDocuments, receiptDocumentsSql, toPortalItem } from "./client-documents";

type Raw = { id: string; title: string; date: string; file_id: string | null; ready: boolean; flag: boolean };
const row = (id: string, date: string, extra: Partial<Raw> = {}): Raw => ({ id, title: id, date, file_id: null, ready: false, flag: true, ...extra });

function fakeClient(byKind: { contract: Raw[]; invoice: Raw[]; receipt: Raw[] }) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const c = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const rows = sql.includes("FROM contracts k") ? byKind.contract : sql.includes("FROM invoice_payments pp") ? byKind.receipt : byKind.invoice;
      return { rows };
    },
  } as unknown as PoolClient;
  return { c, calls };
}

const parts = {
  contractWhere: "W1", invoiceWhere: "W2", receiptWhere: "W3", contractFlag: "TRUE", invoiceFlag: "TRUE", receiptFlag: "FALSE",
  contractParams: ["c", "p"], invoiceParams: ["c"], receiptParams: ["r"],
};

describe("PV5-08 loadDocuments", () => {
  it("merges the three kinds newest first, with a stable kind-then-id tie-break", async () => {
    const { c } = fakeClient({
      contract: [row("k1", "2026-09-01T00:00:00Z"), row("k2", "2026-09-10T00:00:00Z")],
      invoice: [row("i1", "2026-09-10T00:00:00Z")],
      receipt: [row("p1", "2026-09-05"), row("p0", "2026-09-05")],
    });
    const items = await loadDocuments(c, parts);
    expect(items.map((i) => i.id)).toEqual(["i1", "k2", "p0", "p1", "k1"]);
    expect(items.map((i) => i.kind)).toEqual(["invoice", "signed_contract", "receipt", "receipt", "signed_contract"]);
  });

  it("gives each query its own parameters", async () => {
    const { c, calls } = fakeClient({ contract: [], invoice: [], receipt: [] });
    await loadDocuments(c, parts);
    const by = (needle: string) => calls.find((x) => x.sql.includes(needle))!.params;
    expect(by("FROM contracts k")).toEqual(["c", "p"]);
    expect(by("FROM invoices i")).toEqual(["c"]);
    expect(by("FROM invoice_payments pp")).toEqual(["r"]);
  });

  it("keeps `clientVisible` as a strict boolean for staff, and the portal shape has exactly six keys", async () => {
    const { c } = fakeClient({ contract: [row("k1", "2026-09-01T00:00:00Z", { flag: true })], invoice: [], receipt: [row("p1", "2026-09-02", { flag: false })] });
    const items = await loadDocuments(c, parts);
    expect(items.map((i) => i.clientVisible)).toEqual([false, true]);
    for (const i of items) expect(Object.keys(toPortalItem(i)).sort()).toEqual(["date", "fileId", "id", "kind", "ready", "title"]);
  });
});

describe("PV5-08 the SQL names its rules", () => {
  it("contracts: signed only; the sealed copy comes first and `ready` means a sealed copy exists", () => {
    const sql = contractDocumentsSql("W", "TRUE");
    expect(sql).toMatch(/k\.status = 'signed'/);
    expect(sql).toMatch(/COALESCE\(\(SELECT f\.id FROM files f[\s\S]*contract_signed_copy[\s\S]*\), af\.id\) AS file_id/);
    expect(sql).toMatch(/IS NOT NULL\) AS ready/);
  });
  it("invoices: issued only, the stored PDF", () => {
    const sql = invoiceDocumentsSql("W", "TRUE");
    expect(sql).toMatch(/i\.issued_at IS NOT NULL/);
    expect(sql).toMatch(/invoice_pdf/);
  });
  it("receipts: a live stored proof file of that payment", () => {
    const sql = receiptDocumentsSql("W", "TRUE");
    expect(sql).toMatch(/pf\.target_entity_type = 'invoice_payment' AND pf\.target_entity_id = pp\.id/);
    expect(sql).toMatch(/pf\.deleted_at IS NULL/);
  });
});

describe("PV5-08 the controllers use the shared predicates", () => {
  const src = (f: string) => readFileSync(join(__dirname, f), "utf8");
  it("the portal list takes every WHERE from portal-visibility.ts", () => {
    const s = src("portal-documents.controller.ts");
    expect(s).toMatch(/contractInPortalScope\("k"/);
    expect(s).toMatch(/invoiceInPortalScope\("i"/);
    expect(s).toMatch(/invoicePaymentClientVisible\("pp", "detail"\)/);
  });
  it("the staff list flags every kind from the staff builders, never a hand-written expression", () => {
    const s = src("client-documents.controller.ts");
    expect(s).toMatch(/staffClientVisible\("k", contractClientVisible\("k"\)\)/);
    expect(s).toMatch(/staffClientVisible\("i", invoiceClientVisible\("i"\)\)/);
    expect(s).toMatch(/staffInvoicePaymentClientVisible\("pp", "i"\)/);
  });
});
