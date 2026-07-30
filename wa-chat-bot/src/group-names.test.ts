import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { noteDiscovered, discoveredGroups, resetRegistryCache } from "./groups";
import { ensureGroupName, backfillDiscoveredNames, resetGroupNameCache } from "./group-names";

const DIR = "data/test-group-names";
const FILE = join(DIR, "groups.yaml");

function stubFetch(handler: (url: string) => unknown | null) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const body = handler(String(input));
    if (body === null) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("group-names (WAHA subject resolution)", () => {
  beforeEach(() => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, "groups: []\n");
    rmSync(join(DIR, "discovered-groups.json"), { force: true });
    config.groupsFile = FILE;
    config.wahaUrl = "http://waha.test";
    config.wahaSession = "default";
    resetRegistryCache();
    resetGroupNameCache();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("fills a nameless discovered group from WAHA's groups list (NOWEB shape)", async () => {
    noteDiscovered("111@g.us");
    // NOWEB (Baileys): bare-string id + `subject`.
    const fetchMock = stubFetch((url) =>
      url.includes("/groups?") ? [{ id: "111@g.us", subject: "Site A — Construction" }] : null,
    );

    await ensureGroupName("111@g.us");
    expect(discoveredGroups()[0]?.name).toBe("Site A — Construction");

    // Already known -> no further WAHA traffic.
    const before = fetchMock.mock.calls.length;
    await ensureGroupName("111@g.us");
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("understands WAHA's JID-keyed groups map (live NOWEB shape)", async () => {
    noteDiscovered("120363423685633711@g.us");
    stubFetch((url) =>
      url.includes("/groups?")
        ? {
            "120363423685633711@g.us": {
              id: "120363423685633711@g.us",
              subject: "Grow & Glow Bali ✨",
              size: 1,
            },
          }
        : null,
    );
    await ensureGroupName("120363423685633711@g.us");
    expect(discoveredGroups()[0]?.name).toBe("Grow & Glow Bali ✨");
  });

  it("understands the WEBJS shape ({_serialized} id + name)", async () => {
    noteDiscovered("222@g.us");
    stubFetch((url) =>
      url.includes("/groups?") ? [{ id: { _serialized: "222@g.us" }, name: "Back Office" }] : null,
    );
    await ensureGroupName("222@g.us");
    expect(discoveredGroups()[0]?.name).toBe("Back Office");
  });

  it("falls back to the chats overview when the groups endpoint is unavailable", async () => {
    noteDiscovered("333@g.us");
    stubFetch((url) => (url.includes("/chats?") ? [{ id: "333@g.us", name: "Warehouse" }] : null));
    await ensureGroupName("333@g.us");
    expect(discoveredGroups()[0]?.name).toBe("Warehouse");
  });

  it("backfills every nameless group in one sweep and leaves named ones alone", async () => {
    noteDiscovered("111@g.us");
    noteDiscovered("222@g.us", "Already Named");
    noteDiscovered("444@g.us"); // WAHA doesn't know this one
    stubFetch((url) =>
      url.includes("/groups?")
        ? [
            { id: "111@g.us", subject: "Site A" },
            { id: "222@g.us", subject: "Renamed Upstream" },
          ]
        : null,
    );

    expect(await backfillDiscoveredNames()).toBe(1);
    const byId = Object.fromEntries(discoveredGroups().map((g) => [g.id, g.name]));
    expect(byId["111@g.us"]).toBe("Site A");
    expect(byId["222@g.us"]).toBe("Already Named"); // operator-visible name isn't churned
    expect(byId["444@g.us"]).toBe(""); // unresolved -> UI falls back to the JID
  });

  it("degrades quietly when WAHA is unreachable", async () => {
    noteDiscovered("555@g.us");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(ensureGroupName("555@g.us")).resolves.toBeUndefined();
    expect(discoveredGroups()[0]?.name).toBe("");
  });

  it("ignores non-WhatsApp chat ids (Telegram)", async () => {
    const fetchMock = stubFetch(() => null);
    await ensureGroupName("tg:-100123");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
