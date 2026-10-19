import { beforeEach, describe, expect, it } from "vitest";
import { getDemoResponse } from "./demoFixtures";
import { resetDemoBilling } from "./demoBilling";

// DW-10f — the demo twin of the schedule and invoice-from-schedule routes (BFF §61.4 to §61.5) must model the server's REFUSALS in the server's
// ORDER and shape ({error: <code>, reason: <code>}, `detail` where §61 names one), or a browser run in DEMO_MODE proves nothing about the real
// routes. Viceroy (cl-4) carries every case §61.9 lists for these screens; Lumen Studio (cl-3) is the old send/countersign client.

const HANSEL = "demo-hansel";
const MANAGER = "dept-manager"; // may read contracts and invoices, nothing else
const IC = "gede-ic"; // refused every one of these routes
const T = "co-agency";

const call = (method: string, path: string, user: string, body?: unknown) =>
  getDemoResponse(method, path, user, body === undefined ? undefined : JSON.stringify(body));
const json = (r: { json: unknown }) => r.json as Record<string, any>;
const reason = (r: { json: unknown }) => (r.json as { reason?: string }).reason;
const contract = (id: string, user = HANSEL) => json(call("GET", `/api/${T}/contracts/${id}`, user));
const billable = (qs = "?clientId=cl-4", user = HANSEL) => call("GET", `/api/${T}/invoices/billable-instalments${qs}`, user);
const itemsOf = (qs?: string) => (json(billable(qs)).items as Array<Record<string, any>>);
const dayOnly = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

beforeEach(() => resetDemoBilling());

describe("demo seeds · every case of BFF §61.9", () => {
  const list = () => json(call("GET", `/api/${T}/contracts?clientId=cl-4`, HANSEL)) as unknown as Array<Record<string, any>>;
  const by = (id: string) => (list() as Array<Record<string, any>>).find((k) => k.id === id) as Record<string, any>;

  it("a draft with a 50/50 schedule that adds up, a draft with no schedule, a signed agreement with an invoiced and a due instalment, an amendment, an addable signed agreement, and one added after signing", () => {
    expect(by("dk-10")).toMatchObject({ status: "draft", scheduleSummary: { count: 2, total: 120_000_000, matchesValue: true }, scheduleAddable: false });
    expect(by("dk-11")).toMatchObject({ status: "draft", scheduleSummary: null, scheduleAddable: false });
    expect(by("dk-12")).toMatchObject({ status: "signed", scheduleSummary: { count: 3, total: 90_000_000, matchesValue: true } });
    expect(by("dk-13")).toMatchObject({ status: "signed", kind: "amendment", scheduleSummary: { count: 1, total: 15_000_000, matchesValue: true } });
    expect(by("dk-14")).toMatchObject({ status: "signed", scheduleSummary: null, scheduleAddable: true });
    expect(by("dk-15")).toMatchObject({ status: "signed", scheduleSummary: { count: 2 }, scheduleAddable: false });
  });

  it("the detail carries each instalment's derived state, and the invoice that claims it", () => {
    const s = contract("dk-12").schedule;
    expect(s.instalments.map((i: any) => i.state)).toEqual(["invoiced", "due", "upcoming"]);
    expect(s.instalments[0].invoice).toMatchObject({ id: "inv-sch-1", invoiceNo: "DEMO/2026/0002", status: "sent" });
    expect(s.instalments[1].invoice).toBeNull();
    expect(s).toMatchObject({ currency: "IDR", value: 90_000_000, total: 90_000_000, matchesValue: true, addedAfterSigning: null });
  });

  it("a draft's instalments are 'scheduled', and a schedule added after signing says who and when", () => {
    expect(contract("dk-10").schedule.instalments.map((i: any) => i.state)).toEqual(["scheduled", "scheduled"]);
    const added = contract("dk-15").schedule;
    expect(added.addedAfterSigning).toMatchObject({ by: { id: "demo-owner", name: "Olive Owner" } });
    expect(typeof added.addedAfterSigning.at).toBe("string");
    expect(contract("dk-14").schedule).toBeNull();
  });

  it("the old demo client keeps working: Lumen's draft has its own 'all on signing' schedule, so the send flow still runs", () => {
    expect(json(call("GET", `/api/${T}/contracts/dk-7`, HANSEL)).scheduleSummary).toMatchObject({ count: 1, total: 900, matchesValue: true });
    expect(call("POST", `/api/${T}/contracts/dk-7/send`, HANSEL).status).toBe(200);
  });
});

describe("demo · PUT contracts/:id/schedule (BFF §61.4)", () => {
  const put = (id: string, instalments: unknown, user = HANSEL) => call("PUT", `/api/${T}/contracts/${id}/schedule`, user, { instalments });
  const ROWS = [{ label: "Month 1", amount: "3333334", due: "2027-01-31" }, { label: "Month 2", amount: "3333333", due: "2027-02-28" }, { label: "Month 3", amount: "3333333", due: "2027-03-31" }];

  it("replaces a draft's whole schedule and answers it with matchesValue", () => {
    const r = put("dk-11", ROWS);
    expect(r.status).toBe(200);
    expect(json(r)).toMatchObject({ currency: "IDR", value: 10_000_000, total: 10_000_000, matchesValue: true });
    expect(json(r).instalments.map((i: any) => [i.position, i.amount, i.state])).toEqual([[1, 3333334, "scheduled"], [2, 3333333, "scheduled"], [3, 3333333, "scheduled"]]);
    expect(contract("dk-11").scheduleSummary).toMatchObject({ count: 3, matchesValue: true });
  });

  it("may not add up yet: it says matchesValue false and the list says so", () => {
    expect(json(put("dk-11", ROWS.slice(0, 1))).matchesValue).toBe(false);
    expect(contract("dk-11").scheduleSummary).toMatchObject({ count: 1, total: 3333334, matchesValue: false });
  });

  it("[] clears it and answers an object with no instalments, not null", () => {
    const r = put("dk-10", []);
    expect(r.status).toBe(200);
    expect(json(r)).toMatchObject({ instalments: [], total: 0, matchesValue: false });
    expect(contract("dk-10").schedule).toBeNull();
  });

  it("🔴 authorizes BEFORE it validates (a member with a bad body gets 403), and a manager who may only read gets 403", () => {
    expect(put("dk-11", "not a list", IC).status).toBe(403);
    expect(put("dk-11", ROWS, MANAGER).status).toBe(403);
  });

  it("🔴 refuses in the server's order: 404, then frozen, then the body, then the value", () => {
    expect(reason(put("nope", ROWS))).toBe("contract_not_found");
    expect(put("nope", ROWS).status).toBe(404);
    // a signed contract is frozen even with a bad body
    expect(put("dk-12", "not a list").status).toBe(409);
    expect(reason(put("dk-12", "not a list"))).toBe("schedule_frozen");
    expect(reason(put("dk-11", "not a list"))).toBe("schedule_invalid");
    expect(reason(put("dk-2", ROWS))).toBe("schedule_needs_value"); // dk-2 is a draft with no value (cl-1)
  });

  it("every body rule is a typed 400 with `error` and `reason` the same code", () => {
    const cases: Array<[unknown, string]> = [
      [[{ label: " ", amount: "1", due: "on_signing" }], "schedule_invalid"],
      [[{ label: "x".repeat(121), amount: "1", due: "on_signing" }], "schedule_invalid"],
      [[{ label: "A", amount: "0", due: "on_signing" }], "schedule_invalid"],
      [[{ label: "A", amount: "-5", due: "on_signing" }], "schedule_invalid"],
      [[{ label: "A", amount: "1e6", due: "on_signing" }], "schedule_invalid"],
      [[{ label: "A", amount: "1", due: "2026-02-30" }], "schedule_invalid"],
      [Array.from({ length: 61 }, () => ({ label: "A", amount: "1", due: "2027-01-01" })), "schedule_invalid"],
      [[{ label: "A", amount: "1", due: "2027-01-01" }, { label: "B", amount: "1", due: "on_signing" }], "schedule_order_invalid"],
      [[{ label: "A", amount: "1", due: "2027-02-01" }, { label: "B", amount: "1", due: "2027-01-01" }], "schedule_order_invalid"],
      [[{ label: "A", amount: "1.5", due: "on_signing" }], "schedule_precision"], // IDR has no decimals
    ];
    for (const [rows, code] of cases) {
      const r = put("dk-11", rows);
      expect(r.status, code).toBe(400);
      expect(json(r), code).toMatchObject({ error: code, reason: code });
    }
  });

  it("an unknown currency is currency_unknown", () => {
    const made = json(call("POST", `/api/${T}/contracts`, HANSEL, { clientId: "cl-4", title: "Odd", value: 100, currency: "XXX", bodyMd: "t" }));
    expect(reason(put(made.id, [{ label: "A", amount: "100", due: "on_signing" }]))).toBe("currency_unknown");
  });
});

describe("demo · Send needs a schedule that adds up (BFF §61.1 row 3, §61.4)", () => {
  const send = (id: string) => call("POST", `/api/${T}/contracts/${id}/send`, HANSEL);

  it("🔴 a draft with a value and no schedule is refused 400 schedule_total_mismatch with the figures, and stays a draft", () => {
    const r = send("dk-11");
    expect(r.status).toBe(400);
    expect(json(r)).toMatchObject({ error: "schedule_total_mismatch", reason: "schedule_total_mismatch", detail: { value: 10_000_000, total: 0 } });
    expect(contract("dk-11").status).toBe("draft");
  });

  it("a schedule that does not add up is refused with its total; one that does can be sent and carries scheduleSha256", () => {
    call("PUT", `/api/${T}/contracts/dk-11/schedule`, HANSEL, { instalments: [{ label: "A", amount: "9000000", due: "on_signing" }] });
    expect(json(send("dk-11"))).toMatchObject({ detail: { value: 10_000_000, total: 9_000_000 } });
    call("PUT", `/api/${T}/contracts/dk-11/schedule`, HANSEL, { instalments: [{ label: "A", amount: "10000000", due: "on_signing" }] });
    const ok = send("dk-11");
    expect(ok.status).toBe(200);
    expect(typeof json(ok).scheduleSha256).toBe("string");
    expect(contract("dk-11").status).toBe("sent");
  });

  it("after the send the schedule is frozen: PUT is 409 schedule_frozen, and PATCH takes only a void", () => {
    expect(send("dk-10").status).toBe(200);
    expect(call("PUT", `/api/${T}/contracts/dk-10/schedule`, HANSEL, { instalments: [] }).status).toBe(409);
    const edit = call("PATCH", `/api/${T}/contracts/dk-10`, HANSEL, { title: "New title" });
    expect(edit.status).toBe(400);
    expect(json(edit).reason).toBe("only_void_after_send");
    expect(call("PATCH", `/api/${T}/contracts/dk-10`, HANSEL, { status: "void" }).status).toBe(200);
  });

  it("a contract with no value is sent with no schedule, as before", () => {
    expect(send("dk-2").status).toBe(200);
  });
});

describe("demo · POST contracts/:id/schedule/after-signing (BFF §61.4a, DW-D49)", () => {
  const add = (id: string, instalments: unknown, user = HANSEL) => call("POST", `/api/${T}/contracts/${id}/schedule/after-signing`, user, { instalments });
  const HALVES = [{ label: "First half", amount: "12000000", due: "on_signing" }, { label: "Second half", amount: "12000000", due: dayOnly(-30) }];

  it("adds a schedule once to a signed contract with a value and none: 201, recorded, frozen", () => {
    const r = add("dk-14", HALVES);
    expect(r.status).toBe(201);
    expect(json(r).addedAfterSigning).toMatchObject({ by: { id: HANSEL, name: "Hansel (demo)" } });
    expect(json(r).instalments.map((i: any) => i.state)).toEqual(["due", "upcoming"]);
    expect(contract("dk-14")).toMatchObject({ scheduleAddable: false, scheduleSummary: { count: 2, matchesValue: true } });
    // and it is billable at once: the on-signing one is due
    expect(itemsOf().some((i) => i.label === "First half" && i.state === "due")).toBe(true);
  });

  it("🔴 once: a second addition, or one on a contract that already has a schedule, is 409 schedule_exists", () => {
    expect(add("dk-14", HALVES).status).toBe(201);
    expect(reason(add("dk-14", HALVES))).toBe("schedule_exists");
    expect(reason(add("dk-12", HALVES))).toBe("schedule_exists");
    expect(reason(add("dk-15", HALVES))).toBe("schedule_exists");
  });

  it("🔴 refuses in the server's order, each a typed answer", () => {
    expect(add("dk-14", HALVES, IC).status).toBe(403);
    expect(add("dk-14", HALVES, MANAGER).status).toBe(403);
    expect(reason(add("nope", HALVES))).toBe("contract_not_found");
    expect(json(add("dk-10", HALVES))).toMatchObject({ error: "contract_not_signed", reason: "contract_not_signed" }); // a draft
    expect(add("dk-10", HALVES).status).toBe(409);
    call("PATCH", `/api/${T}/contracts/dk-14`, HANSEL, { status: "void" });
    expect(reason(add("dk-14", HALVES))).toBe("contract_closed");
  });

  it("a signed contract with no value needs one (400); an empty list is schedule_invalid here; a total that does not match is named", () => {
    expect(reason(add("dk-5", HALVES))).toBe("schedule_needs_value"); // Mutual NDA: signed, no value
    expect(reason(add("dk-14", []))).toBe("schedule_invalid");
    const mismatch = add("dk-14", [{ label: "Only", amount: "20000000", due: "on_signing" }]);
    expect(mismatch.status).toBe(400);
    expect(json(mismatch)).toMatchObject({ error: "schedule_total_mismatch", detail: { value: 24_000_000, total: 20_000_000 } });
    expect(contract("dk-14").scheduleAddable).toBe(true); // nothing was written
  });
});

describe("demo · GET invoices/billable-instalments (BFF §61.5)", () => {
  it("lists the due and upcoming instalments of signed contracts, oldest due first, and not the invoiced one", () => {
    const rows = itemsOf();
    expect(rows.map((i) => [i.contract.reference, i.label, i.state])).toEqual([
      ["GDA-2026-041", "Milestone: design approved", "due"],
      ["GDA-2026-041-A1", "Amendment fee", "due"],
      ["GDA-2026-044", "Month 1", "upcoming"],
      ["GDA-2026-041", "Milestone: launch", "upcoming"],
      ["GDA-2026-044", "Month 2", "upcoming"],
    ]);
  });

  it("each row has §61.5's shape", () => {
    const row = itemsOf().find((i) => i.label === "Amendment fee") as Record<string, any>;
    expect(row).toMatchObject({
      client: { id: "cl-4", name: "Viceroy" }, contract: { title: "Amendment 1: extra pages", reference: "GDA-2026-041-A1", kind: "amendment", projectId: null },
      position: 1, count: 1, amount: 15_000_000, currency: "IDR", due: { kind: "on_signing" }, state: "due", invoice: null,
    });
    expect(typeof row.instalmentId).toBe("string");
  });

  it("is ordered by due date and says its dueBy; moving dueBy forward turns an upcoming row due", () => {
    const answer = json(billable(`?clientId=cl-4&dueBy=${dayOnly(-365)}`));
    expect(answer.dueBy).toBe(dayOnly(-365));
    expect(answer.items.every((i: any) => i.state === "due")).toBe(true);
    const dates = answer.items.map((i: any) => i.due.on);
    expect([...dates].sort()).toEqual(dates);
  });

  it("narrows to a client, and every client when none is named", () => {
    expect(itemsOf("?clientId=cl-3")).toEqual([]);
    expect(itemsOf("").length).toBe(itemsOf("?clientId=cl-4").length);
  });

  it("🔴 reads need invoice read then contract read: 403 for a member, and a bad date is a typed 400", () => {
    expect(billable("?clientId=cl-4", IC).status).toBe(403);
    expect(billable("?clientId=cl-4&dueBy=2026-02-30").status).toBe(400);
    expect(reason(billable("?clientId=cl-4&dueBy=soon"))).toBe("due_by_invalid");
  });
});

describe("demo · POST invoices {source: 'instalments'} and Cancel draft (BFF §61.5)", () => {
  const ids = () => Object.fromEntries(itemsOf().map((i) => [i.label, i.instalmentId]));
  const draft = (body: Record<string, unknown>, user = HANSEL) => call("POST", `/api/${T}/invoices`, user, { source: "instalments", clientId: "cl-4", ...body });
  const invoice = (id: string) => json(call("GET", `/api/${T}/invoices/${id}`, HANSEL));

  it("🔴 drafts an invoice of fixed-fee lines, claims the instalments, and says what it made", () => {
    const i = ids();
    const r = draft({ instalmentIds: [i["Milestone: design approved"], i["Amendment fee"]], taxCode: "PPN" });
    expect(r.status).toBe(201);
    expect(json(r)).toMatchObject({ source: "instalments", lineCount: 2, total: 45_000_000, currency: "IDR" });
    const inv = invoice(json(r).id);
    expect(inv).toMatchObject({ status: "draft", clientId: "cl-4", taxCode: "PPN", total: 45_000_000 });
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines[0]).toMatchObject({ kind: "instalment", contractId: "dk-12", amount: 30_000_000 });
    expect(inv.lines[0]).not.toHaveProperty("hours");
    expect(inv.lines[0]).not.toHaveProperty("rate");
    // the instalments now read 'invoicing' and link the draft
    const claimed = itemsOf().filter((x) => x.state === "invoicing");
    expect(claimed).toHaveLength(2);
    expect(claimed[0].invoice).toEqual({ id: json(r).id, status: "draft" });
  });

  it("🔴 a replay of exactly the same instalments answers the same draft, deduped; nothing new is made", () => {
    const i = ids();
    const first = json(draft({ instalmentIds: [i["Amendment fee"]] }));
    const again = draft({ instalmentIds: [i["Amendment fee"]] });
    expect(again.status).toBe(201);
    expect(json(again)).toMatchObject({ id: first.id, deduped: true });
  });

  it("🔴 an instalment already on another draft is 409 instalment_unavailable with the claiming invoice, and nothing is written", () => {
    const i = ids();
    const first = json(draft({ instalmentIds: [i["Amendment fee"]] }));
    const r = draft({ instalmentIds: [i["Amendment fee"], i["Milestone: design approved"]] });
    expect(r.status).toBe(409);
    expect(json(r)).toMatchObject({ error: "instalment_unavailable", reason: "instalment_unavailable", detail: { items: [{ instalmentId: i["Amendment fee"], reason: "already_invoiced", invoiceId: first.id }] } });
    expect(itemsOf().find((x) => x.label === "Milestone: design approved")?.state).toBe("due"); // not claimed
  });

  it("names each reason an instalment is unavailable: not due, not found, another client", () => {
    const i = ids();
    const items = (r: { json: unknown }) => json(r).detail.items as Array<Record<string, string>>;
    expect(items(draft({ instalmentIds: [i["Milestone: launch"]] }))[0].reason).toBe("not_due");
    expect(items(draft({ instalmentIds: ["nope"] }))[0].reason).toBe("not_found");
    expect(items(draft({ clientId: "cl-3", instalmentIds: [i["Amendment fee"]] }))[0].reason).toBe("other_client");
    // dueBy moved forward makes the upcoming one billable
    expect(draft({ instalmentIds: [i["Milestone: launch"]], dueBy: dayOnly(-365) }).status).toBe(201);
  });

  it("🔴 every 400 of §61.5 in its order, authorized first, DW-D48: never mixed", () => {
    const i = ids();
    expect(draft({ instalmentIds: [i["Amendment fee"]] }, IC).status).toBe(403);
    expect(draft({}, IC).status).toBe(403); // no body is read before the authorization
    const code = (r: { status: number; json: unknown }) => [r.status, reason(r)];
    expect(code(draft({ instalmentIds: [i["Amendment fee"]], rate: 100 }))).toEqual([400, "source_fields_mixed"]);
    expect(code(draft({ instalmentIds: [i["Amendment fee"]], periodStart: "2026-01-01" }))).toEqual([400, "source_fields_mixed"]);
    expect(code(draft({}))).toEqual([400, "instalment_ids_invalid"]);
    expect(code(draft({ instalmentIds: [] }))).toEqual([400, "instalment_ids_invalid"]);
    expect(code(draft({ instalmentIds: ["a", "a"] }))).toEqual([400, "instalment_ids_invalid"]);
    expect(code(draft({ instalmentIds: [i["Amendment fee"]], dueBy: "2026-02-30" }))).toEqual([400, "due_by_invalid"]);
    expect(code(draft({ instalmentIds: [i["Amendment fee"]], taxCode: "bad code!" }))).toEqual([400, "tax_code_invalid"]);
    expect(code(draft({ clientId: "cl-999", instalmentIds: [i["Amendment fee"]] }))).toEqual([404, "client_not_found"]);
  });

  it("the hourly draft is the explicit exception: unchanged, and it refuses instalment fields and an unknown source", () => {
    const hourly = call("POST", `/api/${T}/invoices`, HANSEL, { clientId: "cl-1", periodStart: "2026-06-01", periodEnd: "2026-06-30", rate: 100, currency: "USD" });
    expect(hourly.status).toBe(201);
    expect(invoice(json(hourly).id).lines[0]).toHaveProperty("hours");
    expect(reason(call("POST", `/api/${T}/invoices`, HANSEL, { clientId: "cl-1", rate: 100, instalmentIds: ["a"] }))).toBe("source_fields_mixed");
    expect(reason(call("POST", `/api/${T}/invoices`, HANSEL, { source: "both", clientId: "cl-1" }))).toBe("source_invalid");
  });

  it("🔴 Cancel draft is a void that releases the instalments and counts them; the invoice stays void", () => {
    const i = ids();
    const made = json(draft({ instalmentIds: [i["Milestone: design approved"], i["Amendment fee"]] }));
    const r = call("PATCH", `/api/${T}/invoices/${made.id}`, HANSEL, { status: "void" });
    expect(r.status).toBe(200);
    expect(json(r)).toEqual({ ok: true, releasedInstalments: 2 });
    expect(invoice(made.id).status).toBe("void");
    expect(itemsOf().filter((x) => x.state === "due").map((x) => x.label).sort()).toEqual(["Amendment fee", "Milestone: design approved"]);
    // and they can be billed again
    expect(draft({ instalmentIds: [i["Amendment fee"]] }).status).toBe(201);
    // a second cancel releases nothing more
    expect(json(call("PATCH", `/api/${T}/invoices/${made.id}`, HANSEL, { status: "void" })).releasedInstalments).toBe(0);
  });

  it("🔴 a cancelled instalment invoice cannot come back (PD614), and an ISSUED invoice cannot be cancelled this way", () => {
    const i = ids();
    const made = json(draft({ instalmentIds: [i["Amendment fee"]] }));
    call("PATCH", `/api/${T}/invoices/${made.id}`, HANSEL, { status: "void" });
    const back = call("PATCH", `/api/${T}/invoices/${made.id}`, HANSEL, { status: "draft" });
    expect(back.status).toBe(409);
    expect(reason(back)).toBe("invoice_unvoid_refused");
    expect(call("PATCH", `/api/${T}/invoices/inv-sch-1`, HANSEL, { status: "void" }).status).toBe(409);
    expect(invoice("inv-sch-1").status).toBe("sent");
  });

  it("the three readiness blockers: a contract voided after the draft blocks it, and cancelling the draft releases the instalment", () => {
    const i = ids();
    const made = json(draft({ instalmentIds: [i["Milestone: design approved"]] }));
    const ready = () => (json(call("GET", `/api/${T}/invoices/${made.id}/issue-readiness`, HANSEL)).blockers as Array<{ code: string }>).map((b) => b.code);
    expect(ready()).not.toContain("INSTALMENT_CONTRACT_NOT_SIGNED");
    call("PATCH", `/api/${T}/contracts/dk-12`, HANSEL, { status: "void" });
    expect(ready()).toContain("INSTALMENT_CONTRACT_NOT_SIGNED");
    expect(json(call("PATCH", `/api/${T}/invoices/${made.id}`, HANSEL, { status: "void" })).releasedInstalments).toBe(1);
    // the released instalment of a voided contract is not billed
    expect(contract("dk-12").schedule.instalments[1]).toMatchObject({ state: "not_billed", notBilledReason: "void" });
  });
});
