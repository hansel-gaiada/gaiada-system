// DW-7j f10 and f12 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2 and §40.6.5): IT's uptime and devices alerting, called through their
// registered `gated("it", ...)` wrappers with a ReaderCtx against live Postgres + RLS. The zone is Asia/Makassar (UTC+8, no DST):
// window Sep 1 .. Sep 30 2026 is [2026-08-31T16:00Z, 2026-09-30T16:00Z), 30 days = 2,592,000 s.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../../../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../../testing/setup";
import { createCompany } from "../../../../testing/fixtures";
import { at } from "../../../../testing/dept-kpi-seed";
import { turnModulesOff } from "../../../../testing/finance-kpi-seed";
import { seedDeviceWithEvents } from "../../../../testing/it-kpi-seed";
import type { ReaderCtx } from "../types";
import { FUNCTIONAL_READERS } from "./index";

const uptime = FUNCTIONAL_READERS["it.uptime"];
const alerting = FUNCTIONAL_READERS["it.devices_alerting"];

const DAY = 86400;

describe.skipIf(!TEST_URL)("DW-7j f10 it.uptime and f12 it.devices_alerting (live PG + RLS)", () => {
  let co: string; // f10: a device registered mid-window, one down across the window's start, pairs, degraded, the asOf cap
  let edge: string; // f10: events exactly at the window's start and one second before it
  let other: string; // another company's devices
  let off: string; // IT turned off
  let empty: string; // IT on, no device
  let al: string; // f12
  let fine: string; // f12: every device up
  let late: string; // f12: devices registered after asOf only
  let savedTz: string;

  const ctx = (over: Partial<ReaderCtx> = {}): ReaderCtx => ({
    tenantId: co, unitId: "d-it", periodKind: "month", start: "2026-09-01", end: "2026-09-30", asOf: "2026-09-30", ...over,
  });
  /** `date` local + `h` hours (+ `s` seconds). */
  const local = (date: string, h = 0, s = 0) => at(date, h * 3600 + s);

  beforeAll(async () => {
    await initTestDb();
    savedTz = config.reportsTz;
    config.reportsTz = "Asia/Makassar";
    co = await createCompany("DW-7j f10 Co", ["it"]);
    edge = await createCompany("DW-7j f10 Edge", ["it"]);
    other = await createCompany("DW-7j f10 Other", ["it"]);
    off = await createCompany("DW-7j f10 Off", ["it"]);
    empty = await createCompany("DW-7j f10 Empty", ["it"]);
    al = await createCompany("DW-7j f12 Co", ["it"]);
    fine = await createCompany("DW-7j f12 Fine", ["it"]);
    late = await createCompany("DW-7j f12 Late", ["it"]);

    const aug1 = await local("2026-08-01");
    // co: 30-day devices unless noted (the window is 30 days)
    await seedDeviceWithEvents(co, { created: aug1 }); // A: no event, online from registration: 30 d up
    await seedDeviceWithEvents(co, { created: await local("2026-09-11") }); // B: registered mid-window: 20 d, all up
    await seedDeviceWithEvents(co, { created: aug1 }, [
      ["offline", await local("2026-08-20", 10)], ["online", await local("2026-09-03")],
    ]); // C: down across the window's start, back Sep 3 00:00: 2 d down
    await seedDeviceWithEvents(co, { created: aug1 }, [
      ["offline", await local("2026-09-10")], ["online", await local("2026-09-12")],
    ]); // D: an offline -> online pair inside the window: 2 d down
    await seedDeviceWithEvents(co, { created: aug1 }, [
      ["degraded", await local("2026-09-05")], ["offline", await local("2026-09-25")], ["degraded", await local("2026-09-27")],
    ]); // E: degraded is up; offline Sep 25 -> degraded Sep 27: 2 d down
    await seedDeviceWithEvents(co, { created: aug1 }, [["offline", await local("2026-09-28")]]); // F: offline to the end: 3 d down
    await seedDeviceWithEvents(co, { created: aug1 }, [["offline", await local("2026-09-30", 0, 86399)]]); // I: offline at 23:59:59 on the last day: 1 s down
    await seedDeviceWithEvents(co, { created: aug1 }, [["offline", await local("2026-10-01")]]); // J: offline at the first instant AFTER the window: 0 down
    await seedDeviceWithEvents(co, { created: aug1 }, [
      ["offline", await local("2026-09-01")], ["heartbeat", await local("2026-09-05")], ["alert", await local("2026-09-06")], ["online", await local("2026-09-02")],
    ]); // K: offline Sep 1 00:00 exactly, online Sep 2 00:00; heartbeat and alert events change nothing: 1 d down
    await seedDeviceWithEvents(co, { created: aug1, deleted: true }, [["offline", await local("2026-08-15")]]); // G: deleted: never counted
    await seedDeviceWithEvents(co, { created: await local("2026-10-05") }, [["offline", await local("2026-10-06")]]); // H: registered after the window
    // other: two devices down since August, which must never reach co or al
    await seedDeviceWithEvents(other, { created: aug1 }, [["offline", aug1]]);
    await seedDeviceWithEvents(other, { created: aug1 }, [["offline", await local("2026-08-02")]]);
    // edge: events at the window's first instant and one second before it
    await seedDeviceWithEvents(edge, { created: aug1 }, [["offline", await local("2026-09-01")], ["online", await local("2026-09-02")]]); // down Sep 1 only: 1 d
    await seedDeviceWithEvents(edge, { created: aug1 }, [["offline", await local("2026-09-01", 0, -1)]]); // offline 1 s before the window, never back: 30 d down
    // off: an IT-less company (turned off after its rows exist)
    await seedDeviceWithEvents(off, { created: aug1 }, [["offline", aug1]]);
    await turnModulesOff(off);

    // f12 (al): asOf Sep 20 or Sep 30
    const aug = await local("2026-08-01");
    await seedDeviceWithEvents(al, { created: aug }, [["online", await local("2026-09-02")]]); // 1 up
    await seedDeviceWithEvents(al, { created: aug }, [["offline", await local("2026-09-10")], ["heartbeat", await local("2026-09-15")], ["alert", await local("2026-09-16")]]); // 2 offline (heartbeat and alert change nothing)
    await seedDeviceWithEvents(al, { created: aug }, [["degraded", await local("2026-09-12")]]); // 3 degraded
    await seedDeviceWithEvents(al, { created: aug }); // 4 no event: online
    await seedDeviceWithEvents(al, { created: aug }, [["offline", await local("2026-09-05")], ["online", await local("2026-09-06")]]); // 5 recovered
    await seedDeviceWithEvents(al, { created: aug }, [["offline", await local("2026-09-25")]]); // 6 offline AFTER asOf Sep 20
    await seedDeviceWithEvents(al, { created: aug }, [["offline", await local("2026-09-20", 0, 86399)]]); // 7 offline at 23:59:59 on Sep 20: in
    await seedDeviceWithEvents(al, { created: aug }, [["offline", await local("2026-09-21")]]); // 8 offline at the first instant after Sep 20: out
    await seedDeviceWithEvents(al, { created: await local("2026-09-22") }, [["offline", await local("2026-09-22", 10)]]); // 9 registered after asOf Sep 20
    await seedDeviceWithEvents(al, { created: aug, deleted: true }, [["offline", await local("2026-09-10")]]); // 10 deleted
    // fine: devices, all up
    await seedDeviceWithEvents(fine, { created: aug }, [["online", await local("2026-09-02")]]);
    await seedDeviceWithEvents(fine, { created: aug });
    await seedDeviceWithEvents(fine, { created: aug }, [["offline", await local("2026-09-05")], ["online", await local("2026-09-06")]]);
    // late: one device, registered after asOf Sep 20 (and offline)
    await seedDeviceWithEvents(late, { created: await local("2026-09-22") }, [["offline", await local("2026-09-22", 10)]]);
  }, 180_000);

  afterAll(async () => {
    config.reportsTz = savedTz;
    await teardownTestDb();
  });

  // ── f10 ───────────────────────────────────────────────────────────────────────────────────────

  it("f10: up-time over device-time, summed over devices, each clipped to its life (registered mid-window) and to the window", async () => {
    // counted: A B C D E F I J K = 30+20+30*7 = 260 d = 22,464,000 s of device-time
    // down: C 2 d, D 2 d, E 2 d, F 3 d, K 1 d = 10 d = 864,000 s, plus I 1 s; J, G (deleted) and H (after the window) add none
    const denominator = 260 * DAY;
    const numerator = denominator - 10 * DAY - 1;
    expect(await uptime(ctx())).toEqual({ value: numerator / denominator, numerator, denominator });
  });

  it("f10: a device down across the window's start counts down only from the start (C: offline Aug 20, online Sep 3)", async () => {
    // only the window Sep 1 .. Sep 2: C is down both days; K (offline from Sep 1 00:00) is down Sep 1 and up Sep 2
    // devices: A C D E F I J K (B is registered Sep 11); 2 days each = 16 d; down: C 2 d, K 1 d, nothing else yet
    const denominator = 16 * DAY;
    const numerator = denominator - 3 * DAY;
    expect(await uptime(ctx({ start: "2026-09-01", end: "2026-09-02", asOf: "2026-09-02" }))).toEqual({ value: numerator / denominator, numerator, denominator });
  });

  it("f10: an offline -> online pair inside the window, and degraded counted as up (D, E)", async () => {
    // Sep 10 .. Sep 11: D is down both days (back Sep 12 00:00); E's degraded since Sep 5 is up. B (registered Sep 11) has 1 day.
    // devices: A C D E F I J K = 8 x 2 d = 16 d + B 1 d = 17 d; down: D 2 d
    const denominator = 17 * DAY;
    const numerator = denominator - 2 * DAY;
    expect(await uptime(ctx({ start: "2026-09-10", end: "2026-09-11", asOf: "2026-09-11" }))).toEqual({ value: numerator / denominator, numerator, denominator });
  });

  it("f10: nothing is counted after asOf (the future is capped): events and devices after it are ignored", async () => {
    // asOf Sep 20: the span ends Sep 21 00:00. A C D E F I J K have 20 d each; B has Sep 11 .. Sep 21 = 10 d.
    // down: C 2 d, D 2 d, K 1 d; E's offline (Sep 25), F's (Sep 28) and I's (Sep 30) are after asOf
    const denominator = 170 * DAY;
    const numerator = denominator - 5 * DAY;
    expect(await uptime(ctx({ asOf: "2026-09-20" }))).toEqual({ value: numerator / denominator, numerator, denominator });
  });

  it("f10: an event at the window's first instant is in, one second before it is the state at the start, one at the end instant is out", async () => {
    // edge: device 1 down Sep 1 only (offline at 00:00 sharp, online Sep 2 00:00): 1 d; device 2 offline 1 s before the window: 30 d
    const denominator = 60 * DAY;
    const numerator = denominator - 31 * DAY;
    expect(await uptime(ctx({ tenantId: edge }))).toEqual({ value: numerator / denominator, numerator, denominator });
    // and J's offline at exactly Oct 1 00:00 is outside: the last day alone reads J up like the other 8 devices there (B is registered by then)
    expect((await uptime(ctx({ start: "2026-09-30", end: "2026-09-30", asOf: "2026-09-30" })))?.denominator).toBe(9 * DAY);
  });

  it("f10: another company's devices are never counted, and the unit makes no difference", async () => {
    expect(await uptime(ctx({ tenantId: other }))).toEqual({ value: 0, numerator: 0, denominator: 30 * DAY * 2 }); // two devices, each down all window
    expect(await uptime(ctx({ unitId: "d-any" }))).toEqual(await uptime(ctx()));
  });

  it("f10: null when no device has any time in the span, and for a company with no device", async () => {
    expect(await uptime(ctx({ start: "2026-07-01", end: "2026-07-31", asOf: "2026-07-31" }))).toBeNull(); // every device is registered later
    expect(await uptime(ctx({ tenantId: empty }))).toBeNull();
    expect(await uptime(ctx({ start: "2026-11-01", end: "2026-11-30", asOf: "2026-09-30" }))).toBeNull(); // the whole window is after asOf
  });

  it("f10: null, never an error, for a company that turned IT off (its old rows stay unread)", async () => {
    expect(await uptime(ctx({ tenantId: off }))).toBeNull();
  });

  // ── f12 ───────────────────────────────────────────────────────────────────────────────────────

  it("f12: counts the devices whose last state change at the end of asOf is offline or degraded (heartbeat and alert events change nothing)", async () => {
    // asOf Sep 30: devices 1..9 (10 is deleted). Alerting: 2 offline, 3 degraded, 6, 7, 8, 9 offline; 1, 4, 5 are up
    expect(await alerting(ctx({ tenantId: al }))).toEqual({ value: 6 });
  });

  it("f12: an event after asOf is ignored, one at 23:59:59 on asOf is in, one at the next midnight is out, a device registered after asOf is not there", async () => {
    // asOf Sep 20: devices 1..8. Alerting: 2, 3, 7. (6 goes offline Sep 25, 8 at Sep 21 00:00, 9 is registered Sep 22)
    expect(await alerting(ctx({ tenantId: al, asOf: "2026-09-20", end: "2026-09-30" }))).toEqual({ value: 3 });
  });

  it("f12: a point in time: the window's start makes no difference, and the unit makes none", async () => {
    expect(await alerting(ctx({ tenantId: al, start: "2026-09-25", end: "2026-09-30" }))).toEqual({ value: 6 });
    expect(await alerting(ctx({ tenantId: al, unitId: "d-any" }))).toEqual({ value: 6 });
  });

  it("f12: a real 0 when the company has devices and all are up", async () => {
    expect(await alerting(ctx({ tenantId: fine }))).toEqual({ value: 0 });
  });

  it("f12: another company's devices are never counted", async () => {
    // other has two devices down since August: its own count is 2, and al's stays 6
    expect(await alerting(ctx({ tenantId: other }))).toEqual({ value: 2 });
  });

  it("f12: null when the company has no device (or none existed yet at the end of asOf)", async () => {
    expect(await alerting(ctx({ tenantId: empty }))).toBeNull();
    expect(await alerting(ctx({ tenantId: late, asOf: "2026-09-20" }))).toBeNull();
    expect(await alerting(ctx({ tenantId: late, asOf: "2026-09-30" }))).toEqual({ value: 1 });
  });

  it("f12: null, never an error, for a company that turned IT off", async () => {
    expect(await alerting(ctx({ tenantId: off }))).toBeNull();
  });
});
