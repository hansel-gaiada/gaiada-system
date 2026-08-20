// [agent-attribution-gate], interim half — the platform records WHO DROVE a write, not only who
// authorized it.
//
// The property under test is the one the memory describes as unrecoverable before this existed: every
// `activities` row said "Alice did X" when the truth was "Alice's agent did X", because `Principal` had
// no channel field and the information had nowhere to live.
//
// Two things are asserted that a looser implementation would get wrong:
//   1. `actor_id` STILL NAMES THE HUMAN. Author and co-author are different fields; the agent must
//      never displace the person accountable for the write.
//   2. Outside a request scope this writes exactly the row it always did. An attribution mechanism
//      that can break a write is worse than one that occasionally adds nothing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership } from "../testing/fixtures";
import { writeActivity } from "./http";
import { runWithRequestContext, setRequestVia, currentVia } from "./request-context";

describe("request context (no DB)", () => {
  it("currentVia is undefined outside a request scope", () => {
    expect(currentVia()).toBeUndefined();
  });

  it("setRequestVia outside a scope is a NO-OP, not a throw", () => {
    // A consumer loop or a unit test calling into a service must not have to set up plumbing.
    expect(() => setRequestVia({ provider: "n8n", externalId: "wf:x" })).not.toThrow();
    expect(currentVia()).toBeUndefined();
  });

  it("a scope carries the via to everything it awaits", async () => {
    await runWithRequestContext(async () => {
      setRequestVia({ provider: "whatsapp", externalId: "628@c.us", agent: "agent:task-filer" });
      // The realistic case: the guard sets it, then several awaits later a handler writes a row.
      await new Promise((r) => setTimeout(r, 1));
      expect(currentVia()?.agent).toBe("agent:task-filer");
    });
  });

  it("🔴 concurrent scopes do not leak into each other", async () => {
    // The reason this is AsyncLocalStorage and not a module-level variable. Two requests in flight
    // would share one field and clobber each other — the same argument the search module's
    // withActualCostCapture header makes.
    const seen: string[] = [];
    await Promise.all([
      runWithRequestContext(async () => {
        setRequestVia({ provider: "a", externalId: "1", agent: "agent:one" });
        await new Promise((r) => setTimeout(r, 5));
        seen.push(currentVia()!.agent!);
      }),
      runWithRequestContext(async () => {
        setRequestVia({ provider: "b", externalId: "2", agent: "agent:two" });
        await new Promise((r) => setTimeout(r, 1));
        seen.push(currentVia()!.agent!);
      }),
    ]);
    expect(seen.sort()).toEqual(["agent:one", "agent:two"]);
  });

  it("the scope ends with the request — no bleed to the next one", async () => {
    await runWithRequestContext(async () => setRequestVia({ provider: "a", externalId: "1", agent: "agent:x" }));
    expect(currentVia()).toBeUndefined();
  });
});

describe.skipIf(!TEST_URL)("writeActivity stamps the co-author", () => {
  let T: string;
  let human: string;

  beforeAll(async () => {
    await initTestDb();
    T = await createCompany("Attribution Co");
    human = await createUser("attrib.human@ex.com", "Attrib Human");
    await addMembership(T, human, "employee");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  const rowsFor = async (verb: string) =>
    (
      await withTenants([T], (c) =>
        c.query<{ actor_id: string | null; metadata: Record<string, unknown> }>(
          `SELECT actor_id, metadata FROM activities WHERE tenant_id = $1 AND verb = $2`,
          [T, verb],
        ),
      )
    ).rows;

  it("🔴 records the AGENT alongside the human, never instead of them", async () => {
    await runWithRequestContext(async () => {
      setRequestVia({ provider: "whatsapp", externalId: "628@c.us", agent: "agent:task-filer" });
      await writeActivity(T, human, "attrib.agent", "employee", human);
    });
    const rows = await rowsFor("attrib.agent");
    expect(rows).toHaveLength(1);
    // Author unchanged — this is the whole point of the Co-Authored-By framing.
    expect(rows[0].actor_id).toBe(human);
    expect(rows[0].metadata.via).toEqual({
      provider: "whatsapp",
      externalId: "628@c.us",
      agent: "agent:task-filer",
    });
  });

  it("a HUMAN-driven request records the channel with NO agent key", async () => {
    // The absence is the signal: `via.agent` missing means a person did this themselves.
    await runWithRequestContext(async () => {
      setRequestVia({ provider: "platform", externalId: "kc-1" });
      await writeActivity(T, human, "attrib.human", "employee", human);
    });
    const via = (await rowsFor("attrib.human"))[0].metadata.via as Record<string, unknown>;
    expect(via).toEqual({ provider: "platform", externalId: "kc-1" });
    expect("agent" in via).toBe(false);
  });

  it("🔴 OUTSIDE a request scope the row is written exactly as before — no `via` key at all", async () => {
    // Sweeps, consumers and the D14 executor all write from outside a request. Attribution must never
    // be able to break them, and an empty `via: {}` would be a lie about a channel we do not know.
    await writeActivity(T, human, "attrib.none", "employee", human, { some: "meta" });
    const md = (await rowsFor("attrib.none"))[0].metadata;
    expect(md).toEqual({ some: "meta" });
    expect("via" in md).toBe(false);
  });

  it("a caller's OWN metadata.via WINS over the ambient one", async () => {
    // The executor re-driving an approved write knows the ORIGINAL filing channel, which is better
    // provenance than the channel of the retry that happens to be running now.
    await runWithRequestContext(async () => {
      setRequestVia({ provider: "whatsapp", externalId: "now", agent: "agent:retrier" });
      await writeActivity(T, human, "attrib.explicit", "employee", human, {
        via: { provider: "n8n", externalId: "wf:original" },
      });
    });
    expect((await rowsFor("attrib.explicit"))[0].metadata.via).toEqual({
      provider: "n8n",
      externalId: "wf:original",
    });
  });

  it("existing metadata is preserved alongside the stamp", async () => {
    await runWithRequestContext(async () => {
      setRequestVia({ provider: "n8n", externalId: "wf:x" });
      await writeActivity(T, human, "attrib.merge", "employee", human, { positionId: "p1" });
    });
    const md = (await rowsFor("attrib.merge"))[0].metadata;
    expect(md.positionId).toBe("p1");
    expect(md.via).toEqual({ provider: "n8n", externalId: "wf:x" });
  });
});
