// SCP-Sc — the pure parts of the simulated publisher on the real dispatch path (no database; the end-to-end cases are
// `simulated-publisher.http.test.ts`, which runs on the Linux CI gate): the publisher's result decision, the "Publish now"
// judgement, the simulator's id advance, the availability rule, the due job's switch, and the static pins that keep Sa's fences true.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../../config";
import { publisherResultOf } from "./publisher-result";
import { judgeSimulatedPublish } from "./simulated-publish";
import { advanceSimulatedPostId, createSimulatedPublisher } from "../publisher/simulated-driver";
import { isSimulatedPublisherAvailable, registerPublisher, resetPublishers } from "../publisher/registry";
import { runSimulatedDueSweep, SIMULATED_DUE_INTERVAL_MS } from "../simulated-due-job";
import { createMockPublisher, newMockPublisherState } from "../publisher/mock-driver";
import { SimulatedOrgHandle } from "../publisher/simulation";

const SRC = join(__dirname, "..", "..", "..");
const source = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const before = config.socialSimulationEnabled;
afterEach(() => {
  config.socialSimulationEnabled = before;
  resetPublishers();
});

const v = (status: string, over: Partial<{ published_url: string | null; published_at: Date | null; simulated: boolean }> = {}) => ({
  status, published_url: null as string | null, published_at: null as Date | null, simulated: false, ...over,
});
const done = (url: string, at: string, simulated = true) => v("published", { published_url: url, published_at: new Date(at), simulated });

describe("SCP-Sc · the publisher's result (publisher_results, publisher_failure)", () => {
  it("every variant published: live, with the FIRST published variant's link and the time the LAST one went out", () => {
    const r = publisherResultOf([
      done("https://simulated.invalid/facebook/a", "2027-03-10T10:00:00Z"),
      done("https://simulated.invalid/instagram/b", "2027-03-10T10:05:00Z"),
    ]);
    expect(r).toEqual({ kind: "live", liveUrl: "https://simulated.invalid/facebook/a", at: "2027-03-10T10:05:00.000Z", simulated: true });
  });

  it("the post is simulated when ANY variant was served by the simulator, and not otherwise", () => {
    expect(publisherResultOf([done("https://x.test/a", "2027-03-10T10:00:00Z", false)])).toMatchObject({ kind: "live", simulated: false });
    expect(publisherResultOf([done("https://x.test/a", "2027-03-10T10:00:00Z", false), done("https://x.test/b", "2027-03-10T10:00:00Z", true)]))
      .toMatchObject({ kind: "live", simulated: true });
  });

  it("a failed variant wins over published siblings: the post is not live (the fixture's publisher_failure)", () => {
    expect(publisherResultOf([done("https://x.test/a", "2027-03-10T10:00:00Z"), v("failed")])).toEqual({ kind: "failed" });
    expect(publisherResultOf([v("queued"), v("failed")])).toEqual({ kind: "failed" });
  });

  it("anything still queued, publishing, approved or draft keeps waiting; no variants at all waits too", () => {
    for (const s of ["queued", "publishing", "approved", "draft", "cancelled"]) {
      expect(publisherResultOf([done("https://x.test/a", "2027-03-10T10:00:00Z"), v(s)]), s).toEqual({ kind: "waiting" });
    }
    expect(publisherResultOf([])).toEqual({ kind: "waiting" });
  });

  it("all published but none with a link: no_link (a live post needs its link; one is never invented)", () => {
    expect(publisherResultOf([v("published"), v("published")])).toEqual({ kind: "no_link" });
    expect(publisherResultOf([v("published", { published_url: "" })])).toEqual({ kind: "no_link" });
  });
});

describe("SCP-Sc · Publish now: who may go on, in the order of the answers", () => {
  const sv = (id: string, status: string, over: Partial<{ account_simulated: boolean; native_import: boolean }> = {}) => ({
    id, status, account_simulated: true, native_import: false, ...over,
  });
  const ok = (variants: ReturnType<typeof sv>[], decided: string[]) =>
    judgeSimulatedPublish({ pipelineStatus: "scheduled", scheduleVia: "publisher", variants, decided: new Set(decided) });

  it("goes on when every variant is decided and is queued or already published", () => {
    expect(ok([sv("a", "queued"), sv("b", "published")], ["a", "b"])).toEqual({ ok: true });
  });

  it("not_scheduled_by_publisher: any other status, a hand schedule, a Composer post, or no variants", () => {
    const base = { variants: [sv("a", "queued")], decided: new Set(["a"]) };
    expect(judgeSimulatedPublish({ ...base, pipelineStatus: "approved", scheduleVia: null })).toMatchObject({ ok: false, code: "not_scheduled_by_publisher" });
    expect(judgeSimulatedPublish({ ...base, pipelineStatus: "scheduled", scheduleVia: "manual" })).toMatchObject({ ok: false, code: "not_scheduled_by_publisher" });
    expect(judgeSimulatedPublish({ ...base, pipelineStatus: null, scheduleVia: null })).toMatchObject({ ok: false, code: "not_scheduled_by_publisher" });
    expect(judgeSimulatedPublish({ ...base, pipelineStatus: "scheduled", scheduleVia: "publisher", variants: [] })).toMatchObject({ ok: false, code: "not_scheduled_by_publisher" });
    expect(judgeSimulatedPublish({ ...base, pipelineStatus: "scheduled", scheduleVia: "publisher", variants: [sv("n", "published", { native_import: true })] }))
      .toMatchObject({ ok: false, code: "not_scheduled_by_publisher" });
  });

  it("simulated_account_required: a variant whose account is not simulated, before the approvals are even looked at", () => {
    expect(ok([sv("a", "queued"), sv("b", "queued", { account_simulated: false })], [])).toMatchObject({ ok: false, code: "simulated_account_required" });
  });

  it("simulated_approval_not_decided names the variants without a decided approval, before dispatch is judged", () => {
    expect(ok([sv("a", "queued"), sv("b", "approved")], ["a"])).toEqual({ ok: false, code: "simulated_approval_not_decided", detail: { variantIds: ["b"] } });
  });

  it("simulated_not_dispatched: decided but not queued (approved, failed, publishing, draft)", () => {
    for (const s of ["approved", "failed", "publishing", "draft"]) {
      expect(ok([sv("a", s)], ["a"]), s).toEqual({ ok: false, code: "simulated_not_dispatched", detail: { variants: [{ id: "a", status: s }] } });
    }
  });
});

describe("SCP-Sc · the simulator's id: advancing its time (the format is unchanged)", () => {
  const ID = "simulated:instagram:1800000000000:0b6a7a52-77c3-4c1f-9d0e-5f2d3f8e1a11";

  it("moves a later time up to the given one and keeps the network and the uuid, so the link is the one it would have had", () => {
    expect(advanceSimulatedPostId(ID, 1700000000000)).toBe("simulated:instagram:1700000000000:0b6a7a52-77c3-4c1f-9d0e-5f2d3f8e1a11");
  });

  it("never moves a time LATER, and truncates a fractional millisecond", () => {
    expect(advanceSimulatedPostId(ID, 1900000000000)).toBe(ID);
    expect(advanceSimulatedPostId(ID, 1700000000000.9)).toBe("simulated:instagram:1700000000000:0b6a7a52-77c3-4c1f-9d0e-5f2d3f8e1a11");
  });

  it("is null for an id the simulator did not mint (a real engine's, a malformed one)", () => {
    for (const id of ["postiz-123", "simulated:instagram:abc:0b6a7a52-77c3-4c1f-9d0e-5f2d3f8e1a11", "simulated:Instagram:1:0b6a", ""]) {
      expect(advanceSimulatedPostId(id, 1), id).toBeNull();
    }
  });

  it("an id the driver mints advances to a time the driver itself reads as due, through the same format", async () => {
    config.socialSimulationEnabled = true;
    const t = 1_000_000;
    const sim = createSimulatedPublisher({ now: () => t, guard: async () => null });
    const handle = new SimulatedOrgHandle("00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000b2", "00000000-0000-4000-8000-0000000000c3");
    const { providerPostId } = await sim.schedulePost(handle, {
      integrationId: "simulated:instagram", network: "instagram", body: "mock", approvalId: "a", variantId: "v", scheduledAt: new Date(5_000_000).toISOString(),
    });
    expect(providerPostId.split(":")[2]).toBe("5000000");
    expect((await sim.getPostStatus(handle, [providerPostId]))[0].state).toBe("queued"); // its time has not come
    const advanced = advanceSimulatedPostId(providerPostId, t)!;
    expect(advanced.split(":")[2]).toBe("1000000");
    expect(advanced.split(":")[3]).toBe(providerPostId.split(":")[3]);
    const status = (await sim.getPostStatus(handle, [advanced]))[0];
    expect(status.state).toBe("published");
    expect(status.publishedUrl).toMatch(/^https:\/\/simulated\.invalid\/instagram\/[0-9a-f-]{36}$/);
  });
});

describe("SCP-Sc · availability goes through resolveSimulatedPublisher's own rule", () => {
  it("true only with the switch on AND the simulator registered AND the capability simulated", () => {
    config.socialSimulationEnabled = true;
    expect(isSimulatedPublisherAvailable("schedule")).toBe(false); // nothing registered
    registerPublisher(createSimulatedPublisher());
    expect(isSimulatedPublisherAvailable("schedule")).toBe(true);
    expect(isSimulatedPublisherAvailable("inbox" as never)).toBe(false); // not simulated
    config.socialSimulationEnabled = false;
    expect(isSimulatedPublisherAvailable("schedule")).toBe(false); // registered, switch off
  });

  it("a real engine's driver is never taken for it, with the switch on or off", () => {
    config.socialSimulationEnabled = false;
    registerPublisher(createMockPublisher(newMockPublisherState())); // keyed like Postiz: allowed with the switch off
    expect(isSimulatedPublisherAvailable("schedule")).toBe(false);
    config.socialSimulationEnabled = true;
    expect(isSimulatedPublisherAvailable("schedule")).toBe(false);
  });
});

describe("SCP-Sc · the due job", () => {
  it("does nothing, and reads nothing, with the switch off", async () => {
    config.socialSimulationEnabled = false;
    expect(await runSimulatedDueSweep()).toEqual({ skipped: true, tenants: 0, reconciled: 0, applied: 0, errors: 0 });
  });

  it("runs every minute, and main.ts starts it only inside the switch's own check", () => {
    expect(SIMULATED_DUE_INTERVAL_MS).toBe(60_000);
    const main = source("main.ts");
    expect(main).toMatch(/if \(isSocialSimulationEnabled\(\)\) \{\s*startSimulatedDueLoop\(SIMULATED_DUE_INTERVAL_MS\);/);
  });
});

describe("SCP-Sc · Sa's fences stay true", () => {
  const NEW_FILES = [
    "modules/social/pipeline/publisher-result.ts", "modules/social/pipeline/simulated-publish.ts", "modules/social/simulated-due-job.ts",
  ];

  it("none of the new files calls resolveSimulatedPublisher (the one road keeps its two on-ramps) or builds a simulator", () => {
    for (const f of NEW_FILES) {
      expect(source(f), f).not.toMatch(/\bresolveSimulatedPublisher\(/);
      expect(source(f), f).not.toMatch(/\bcreateSimulatedPublisher\(/);
    }
  });

  it("the route and the job never write an approval or a simulated mark: no INSERT/UPDATE of automation_approvals, and no variant UPDATE that names the mark", () => {
    for (const f of NEW_FILES) {
      const literals = [...source(f).matchAll(/`[^`]*`/g)].map((m) => m[0]);
      for (const lit of literals) {
        expect(lit, f).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+automation_approvals\b/);
        if (/\bUPDATE\s+social_post_variants\b/.test(lit)) expect(lit, f).not.toMatch(/\bsimulated\b/);
      }
    }
  });

  it("the only variant write in the route is the publish time of a queued variant, guarded by its old value", () => {
    const sql = [...source("modules/social/pipeline/simulated-publish.ts").matchAll(/`[^`]*`/g)].map((m) => m[0]).filter((l) => /UPDATE\s+social_post_variants/.test(l));
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/SET provider_post_id = \$3, updated_at = now\(\)/);
    expect(sql[0]).toMatch(/status = 'queued' AND provider_post_id = \$4/);
  });
});
