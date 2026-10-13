import { describe, it, expect, vi } from "vitest";
import { portalDashboardDemo } from "./demoPortal";

// CP-16 — the demo store's BEHAVIOURAL fidelity, not its data.
//
// Fixtures are usually not worth testing. These are, for one reason: DEMO_MODE is what the `next build`
// gate and the Playwright suite run against, so if the fixture is more permissive than the real BFF, every
// downstream check passes against a backend that does not exist. The two properties that must not drift
// are the identity refusal and the payment claim/confirm split — both are security-shaped, and both are
// invisible in a browser until someone specifically looks.
const T = (p: string) => `/api/co-agency/portal/${p}`;
const CLIENT = "demo-client";

describe("demoPortal fixture fidelity", () => {
  it("refuses a staff caller exactly as the real scope resolver does", () => {
    // Without this the demo would show a staff member a client dashboard, and the staff teach-state on
    // /portal would be unreachable dead code.
    const r = portalDashboardDemo("GET", T("overview"), "demo-hansel");
    expect(r?.status).toBe(403);
    expect((r?.json as { error: string }).error).toMatch(/not a portal client/);
  });

  it("returns null for routes it does not own, so runs/gates still reach demoPipeline", () => {
    // The dispatch order in demoFixtures depends on this: portalDashboardDemo runs FIRST and must fall
    // through for `/portal/runs`, or the WS11 approval flow silently stops working in demo mode.
    expect(portalDashboardDemo("GET", T("runs"), CLIENT)).toBeNull();
    expect(portalDashboardDemo("GET", T("runs/run-demo-1"), CLIENT)).toBeNull();
  });

  it("returns null for a non-portal path", () => {
    expect(portalDashboardDemo("GET", "/api/co-agency/clients", CLIENT)).toBeNull();
  });

  it("serves an overview with a needs-you list and finance totals", () => {
    const r = portalDashboardDemo("GET", T("overview"), CLIENT);
    expect(r?.status).toBe(200);
    const b = r?.json as {
      needsYou: unknown[];
      finance: { primary: { outstanding: number; invoiced: number; paid: number } };
      progress: { percent: number };
    };
    expect(b.needsYou.length).toBeGreaterThan(0);
    // Derived from the invoice + payment fixtures, not hard-coded, so the overview can never contradict
    // the invoices page.
    expect(b.finance.primary.outstanding).toBe(b.finance.primary.invoiced - b.finance.primary.paid);
    expect(b.progress.percent).toBeGreaterThan(0);
  });

  it("404s an unknown project rather than inventing one", () => {
    expect(portalDashboardDemo("GET", T("projects/nope"), CLIENT)?.status).toBe(404);
  });

  it("timeline carries both tenses", () => {
    const events = portalDashboardDemo("GET", T("timeline"), CLIENT)?.json as Array<{ tense: string }>;
    expect(new Set(events.map((e) => e.tense))).toEqual(new Set(["due", "happened"]));
  });

  it("ships an overdue open milestone so the overdue styling is drivable", () => {
    // A fixture with no overdue item leaves the "Was due" branch and the danger colour unreachable in a
    // browser, which is how such a branch ships broken.
    const ms = portalDashboardDemo("GET", T("milestones"), CLIENT)?.json as Array<{ status: string; dueDate: string }>;
    const today = new Date().toISOString().slice(0, 10);
    expect(ms.some((m) => m.status !== "done" && m.dueDate < today)).toBe(true);
  });

  it("ships a contract awaiting the client's signature", () => {
    const list = portalDashboardDemo("GET", T("contracts"), CLIENT)?.json as Array<{ status: string; clientSigned: boolean; providerSigned: boolean }>;
    expect(list.some((k) => k.status === "sent" && !k.clientSigned && k.providerSigned)).toBe(true);
  });

  it("never exposes a draft contract", () => {
    const list = portalDashboardDemo("GET", T("contracts"), CLIENT)?.json as Array<{ status: string }>;
    expect(list.every((k) => k.status !== "draft")).toBe(true);
  });

  // ── the claim/confirm split ───────────────────────────────────────────────────────────────────────
  it("records a payment as PENDING and leaves the balance untouched", () => {
    const before = portalDashboardDemo("GET", T("invoices/inv-2026-021"), CLIENT)?.json as { balance: number; total: number };
    const paidOn = new Date().toISOString().slice(0, 10);
    const r = portalDashboardDemo("POST", T("invoices/inv-2026-021/payments"), CLIENT,
      JSON.stringify({ amount: 1_000_000, paidOn }));
    expect(r?.status).toBe(201);
    expect((r?.json as { status: string }).status).toBe("pending");

    const after = portalDashboardDemo("GET", T("invoices/inv-2026-021"), CLIENT)?.json as {
      balance: number; status: string; payments: Array<{ status: string }>;
    };
    // The property: a client's claim moves NOTHING. Crediting it here would make the behaviour most
    // likely to be misread by a reviewer ("the client marked it paid?") look like the intended design.
    expect(after.balance).toBe(before.balance);
    expect(after.status).toBe("sent");
    expect(after.payments.some((p) => p.status === "pending")).toBe(true);
  });

  it("refuses an overpayment with the same message shape as the BFF", () => {
    const paidOn = new Date().toISOString().slice(0, 10);
    const r = portalDashboardDemo("POST", T("invoices/inv-2026-014/payments"), CLIENT,
      JSON.stringify({ amount: 999_999_999, paidOn }));
    expect(r?.status).toBe(400);
    expect((r?.json as { error: string }).error).toMatch(/outstanding balance/);
  });

  it("refuses a future-dated payment", () => {
    const future = new Date(Date.now() + 86_400_000 * 5).toISOString().slice(0, 10);
    const r = portalDashboardDemo("POST", T("invoices/inv-2026-014/payments"), CLIENT,
      JSON.stringify({ amount: 1, paidOn: future }));
    expect(r?.status).toBe(400);
  });

  // ── signing ───────────────────────────────────────────────────────────────────────────────────────
  it("refuses a signature without the attestation", () => {
    const r = portalDashboardDemo("POST", T("contracts/ctr-sow-brand/sign"), CLIENT,
      JSON.stringify({ signerName: "Dana Whitfield" }));
    expect(r?.status).toBe(400);
    expect((r?.json as { field?: string }).field).toBe("agree");
  });

  it("completes only when both parties are in, and is idempotent on re-sign", () => {
    // ctr-sow-site already carries the PROVIDER signature, so the client's makes it complete.
    const first = portalDashboardDemo("POST", T("contracts/ctr-sow-site/sign"), CLIENT,
      JSON.stringify({ signerName: "Dana Whitfield", agree: true }));
    expect(first?.json).toMatchObject({ complete: true, alreadySigned: false });
    const detail = portalDashboardDemo("GET", T("contracts/ctr-sow-site"), CLIENT)?.json as { status: string; canSign: boolean };
    expect(detail.status).toBe("signed");
    expect(detail.canSign).toBe(false);

    // A double-tapped button on a phone must not read as a failure on something this consequential.
    const again = portalDashboardDemo("POST", T("contracts/ctr-sow-site/sign"), CLIENT,
      JSON.stringify({ signerName: "Dana Whitfield", agree: true }));
    expect(again?.status).toBe(200);
    expect((again?.json as { alreadySigned: boolean }).alreadySigned).toBe(true);
  });

  it("a client signature alone does NOT complete an unsigned-by-us agreement", () => {
    // ctr-sow-brand has no provider signature. The status must stay `sent`.
    const r = portalDashboardDemo("POST", T("contracts/ctr-sow-brand/sign"), CLIENT,
      JSON.stringify({ signerName: "Dana Whitfield", agree: true }));
    expect(r?.json).toMatchObject({ complete: false });
    const detail = portalDashboardDemo("GET", T("contracts/ctr-sow-brand"), CLIENT)?.json as { status: string };
    expect(detail.status).toBe("sent");
  });

  // ── profile ───────────────────────────────────────────────────────────────────────────────────────
  it("updates the caller's own name and nothing else", () => {
    const r = portalDashboardDemo("PATCH", T("profile"), CLIENT,
      JSON.stringify({ name: "Dana W. Whitfield", email: "hijack@evil.test" }));
    expect(r?.status).toBe(200);
    const after = portalDashboardDemo("GET", T("profile"), CLIENT)?.json as { me: { name: string; email: string } };
    expect(after.me.name).toBe("Dana W. Whitfield");
    expect(after.me.email).toBe("dana@northwind.example");
  });

  it("accepts a change request with 202 and does not mutate the client", () => {
    const before = portalDashboardDemo("GET", T("profile"), CLIENT)?.json as { clients: Array<{ name: string }> };
    const r = portalDashboardDemo("POST", T("profile/change-request"), CLIENT,
      JSON.stringify({ message: "New billing address please" }));
    expect(r?.status).toBe(202);
    const after = portalDashboardDemo("GET", T("profile"), CLIENT)?.json as { clients: Array<{ name: string }> };
    expect(after.clients[0].name).toBe(before.clients[0].name);
  });

  it("reports poll mode for the stream, exercising the fallback path", () => {
    // SSE is not representable in a JSON fixture. Reporting `poll` means demo mode and the e2e suite
    // exercise the POLLING path — the one most likely to be broken and least likely to be noticed.
    expect(portalDashboardDemo("GET", T("stream"), CLIENT)?.json).toMatchObject({ mode: "poll" });
  });

  // ── MI-04: maintenance intake (webdev change requests) ─────────────────────────────────────────────
  describe("change requests", () => {
    it("refuses a staff caller exactly like every other portal route here", () => {
      const r = portalDashboardDemo("GET", T("change-requests"), "demo-hansel");
      expect(r?.status).toBe(403);
    });

    it("ships an in_progress row with a REAL pipelineRunId so the mini-run deep-link lands on real content", () => {
      const list = portalDashboardDemo("GET", T("change-requests"), CLIENT)?.json as Array<{
        status: string; pipelineRunId: string | null;
      }>;
      const spawned = list.find((r) => r.status === "in_progress");
      expect(spawned?.pipelineRunId).toBe("run-demo-1");
    });

    it("ships a declined row carrying a reason", () => {
      const list = portalDashboardDemo("GET", T("change-requests"), CLIENT)?.json as Array<{
        status: string; declinedReason: string | null;
      }>;
      expect(list.some((r) => r.status === "declined" && !!r.declinedReason)).toBe(true);
    });

    it("newest first", () => {
      const list = portalDashboardDemo("GET", T("change-requests"), CLIENT)?.json as Array<{ createdAt: string }>;
      const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      expect(list.map((r) => r.createdAt)).toEqual(sorted.map((r) => r.createdAt));
    });

    it("404s an unknown id rather than inventing one", () => {
      expect(portalDashboardDemo("GET", T("change-requests/nope"), CLIENT)?.status).toBe(404);
    });

    it("submits a request and the server derives status/route — never body-supplied", () => {
      const r = portalDashboardDemo("POST", T("change-requests"), CLIENT, JSON.stringify({
        kind: "feature", title: "Add a newsletter signup block",
        // Both of these must be IGNORED — mirrors the real controller's "never body-trusted" rule.
        status: "done", clientId: "someone-elses-client-id",
      }));
      expect(r?.status).toBe(201);
      const created = r?.json as { id: string; status: string };
      expect(created.status).toBe("new");

      const detail = portalDashboardDemo("GET", T(`change-requests/${created.id}`), CLIENT)?.json as {
        status: string; clientId: string; route: string | null;
      };
      expect(detail.status).toBe("new");
      expect(detail.route).toBeNull();
      expect(detail.clientId).toBe("cl-1"); // demo-client's OWN client, never the body-supplied one
    });

    it("refuses an invalid kind", () => {
      const r = portalDashboardDemo("POST", T("change-requests"), CLIENT, JSON.stringify({
        kind: "not-a-kind", title: "Something",
      }));
      expect(r?.status).toBe(400);
      expect((r?.json as { field?: string }).field).toBe("kind");
    });

    it("refuses an empty title", () => {
      const r = portalDashboardDemo("POST", T("change-requests"), CLIENT, JSON.stringify({
        kind: "bug", title: "   ",
      }));
      expect(r?.status).toBe(400);
    });

    it("accepts a client-wide submission with no projectId (demo-client is client-wide)", () => {
      const r = portalDashboardDemo("POST", T("change-requests"), CLIENT, JSON.stringify({
        kind: "content", title: "Update the footer copyright year",
      }));
      const created = r?.json as { id: string };
      const detail = portalDashboardDemo("GET", T(`change-requests/${created.id}`), CLIENT)?.json as {
        projectId: string | null;
      };
      expect(detail.projectId).toBeNull();
    });

    it("404-shaped 'project not found' for a projectId that isn't the caller's", () => {
      const r = portalDashboardDemo("POST", T("change-requests"), CLIENT, JSON.stringify({
        kind: "design", title: "Redesign the invoice PDF", projectId: "not-a-real-project",
      }));
      expect(r?.status).toBe(400);
    });
  });
});

// PV5-09 — the demo's fidelity to the invoice-of-record and content-hash fields, because the browser specs (axe, the stale-hash
// reload) run against it and would pass against a backend that does not exist if it were more permissive than the real one.
describe("demoPortal PV5 fields", () => {
  it("an issued invoice carries its number, dates, the frozen issuer and a payable flag; the taxed one has a tax line", () => {
    const d = portalDashboardDemo("GET", T("invoices/inv-2026-021"), CLIENT)?.json as {
      invoiceNo: string; dueDate: string; subtotal: number; taxTotal: number; total: number; pdfFileId: string | null; payable: boolean;
      issuer: { legalName: string; bank: { accountNo: string } };
      taxLines: Array<{ code: string; rate: number; base: number; amount: number }>;
    };
    expect(d.invoiceNo).toBe("DEMO/2026/0021");
    expect(d.issuer.bank.accountNo).toBeTruthy();
    expect(d.payable).toBe(true);
    expect(d.taxLines).toEqual([{ code: "PPN", rate: 11, base: d.subtotal, amount: d.taxTotal }]);
    // The money agrees with itself: nothing in the page has to add it up.
    expect(d.subtotal + d.taxTotal).toBe(d.total);
    // Not rendered yet: the page must say "being prepared" for this one.
    expect(d.pdfFileId).toBeNull();
  });

  it("a settled invoice is not payable, and one with a rendered PDF carries its file id", () => {
    const paid = portalDashboardDemo("GET", T("invoices/inv-2025-088"), CLIENT)?.json as { payable: boolean; pdfFileId: string | null };
    expect(paid.payable).toBe(false);
    expect(paid.pdfFileId).toBeTruthy();
  });

  it("🔴 a sign with a STALE content hash is refused with a 409 content_changed and writes nothing", async () => {
    // A fresh copy of the store: the tests above spend the unsigned contracts (a re-sign is the idempotent 200, checked first).
    vi.resetModules();
    const { portalDashboardDemo: fresh } = await import("./demoPortal");
    const detail = fresh("GET", T("contracts/ctr-sow-brand"), CLIENT)?.json as { contentSha256: string };
    expect(detail.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    const stale = fresh("POST", T("contracts/ctr-sow-brand/sign"), CLIENT,
      JSON.stringify({ signerName: "Dana Whitfield", agree: true, contentSha256: "0".repeat(64) }));
    expect(stale?.status).toBe(409);
    expect((stale?.json as { reason: string }).reason).toBe("content_changed");
    const after = fresh("GET", T("contracts/ctr-sow-brand"), CLIENT)?.json as { signatures: unknown[] };
    expect(after.signatures).toEqual([]);
    // The hash the page showed is accepted (the signature lands).
    const good = fresh("POST", T("contracts/ctr-sow-brand/sign"), CLIENT,
      JSON.stringify({ signerName: "Dana Whitfield", agree: true, contentSha256: detail.contentSha256.toUpperCase() }));
    expect(good?.status).toBe(200);
  });

  it("a signed contract carries a sealed-copy file id on the detail and the list", () => {
    const d = portalDashboardDemo("GET", T("contracts/ctr-msa-2026"), CLIENT)?.json as { signedCopyFileId: string | null };
    expect(d.signedCopyFileId).toBeTruthy();
    const list = portalDashboardDemo("GET", T("contracts"), CLIENT)?.json as Array<{ id: string; signedCopyFileId: string | null }>;
    expect(list.find((k) => k.id === "ctr-msa-2026")?.signedCopyFileId).toBeTruthy();
  });
});

describe("PV5-08 documents route", () => {
  it("serves signed agreements and invoices newest first, in the real list's shape", () => {
    const r = portalDashboardDemo("GET", T("documents"), CLIENT);
    expect(r?.status).toBe(200);
    const items = (r?.json as { items: Array<{ kind: string; date: string }> }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((i) => i.kind))).toEqual(new Set(["signed_contract", "invoice"]));
    const times = items.map((i) => Date.parse(i.date));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    for (const i of items) expect(Object.keys(i).sort()).toEqual(["date", "fileId", "id", "kind", "ready", "title"]);
  });
  it("refuses a staff caller like every other portal route", () => {
    expect(portalDashboardDemo("GET", T("documents"), "demo-hansel")?.status).toBe(403);
  });
});
