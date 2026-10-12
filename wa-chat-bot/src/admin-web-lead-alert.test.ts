// POST /admin/alerts/web-lead (M5-L5b): auth, strict allow-list body, link exactness, the fixed template,
// the never-an-ingested-chat rule, replay de-duplication, and that the history store never sees the alert.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";

// Spy on EVERY export of the history store (calling through), so "never touched" is provable.
const storeCalls: string[] = [];
vi.mock("./store", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(real)) {
    wrapped[k] = typeof v === "function" ? (...a: unknown[]) => (storeCalls.push(k), (v as (...x: unknown[]) => unknown)(...a)) : v;
  }
  return wrapped;
});

import { buildApp } from "./server";
import { config } from "./config";
import { resetRegistryCache, setIgnored } from "./groups";
import { resetWebLeadAlertState, composeWebLeadAlertText } from "./web-lead-alert";
import { SurfaceRouter } from "./surface";
import { resetRateLimiter } from "./safety/rate-limit";
import { resetOutboundCeilingCounters } from "./safety/outbound-ceiling";
import { setOutboundHalt, resetOutboundHalt } from "./safety/outbound-halt";
import { resetLoopGuard } from "./safety/loop-guard";

const DIR = "data/test-admin-web-lead-alert";
const LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASE = "https://erp.example.test";
const DM = "628110000000@c.us";
const TG_DM = "tg:424242";
const AUTH = { authorization: "Bearer sekret" };
const good = (over: Record<string, unknown> = {}) => ({
  leadId: LEAD, firstName: "Ayu", form: "contact", link: `${BASE}/agency/leads/${LEAD}`, ...over,
});

function post(app: ReturnType<typeof buildApp>, payload: unknown, headers: Record<string, string> = AUTH) {
  return app.inject({ method: "POST", url: "/admin/alerts/web-lead", headers, payload: payload as object });
}

describe("POST /admin/alerts/web-lead", () => {
  let sendText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    config.adminToken = "sekret";
    config.groupsFile = `${DIR}/groups.yaml`;
    config.groupsSeedFile = "";
    config.webLeadAlertStateFile = `${DIR}/web-lead-alerts.json`;
    config.webLeadAlertChatId = DM;
    config.webLeadAlertLinkBase = BASE;
    resetRegistryCache();
    resetWebLeadAlertState();
    storeCalls.length = 0;
    sendText = vi.fn(async () => {});
  });
  afterEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    config.webLeadAlertChatId = "";
    config.webLeadAlertLinkBase = "";
    config.webLeadAlertStateFile = "";
    vi.restoreAllMocks();
  });
  const app = () => buildApp({ sendText } as any);

  describe("auth", () => {
    it("401 without the token and 401 with a wrong one; nothing sent", async () => {
      const a = app();
      expect((await post(a, good(), {})).statusCode).toBe(401);
      expect((await post(a, good(), { authorization: "Bearer nope" })).statusCode).toBe(401);
      expect(sendText).not.toHaveBeenCalled();
      await a.close();
    });
    it("503 when ADMIN_TOKEN is unset (fail-closed), even with a bearer", async () => {
      config.adminToken = "";
      const a = app();
      expect((await post(a, good(), { authorization: "Bearer whatever" })).statusCode).toBe(503);
      expect(sendText).not.toHaveBeenCalled();
      await a.close();
    });
  });

  describe("configuration (off by default)", () => {
    it.each(["", "   "])("destination %j means unset: 503 alert-destination-unset", async (v) => {
      config.webLeadAlertChatId = v;
      const a = app();
      const res = await post(a, good());
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "alert-destination-unset" });
      expect(sendText).not.toHaveBeenCalled();
      await a.close();
    });
    it("503 when the ERP link base is unset", async () => {
      config.webLeadAlertLinkBase = "";
      const a = app();
      const res = await post(a, good());
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "alert-link-base-unset" });
      await a.close();
    });
  });

  describe("body validation (strict allow-list)", () => {
    it.each([
      ["unknown key", good({ email: "a@b.test" })],
      ["unknown key (phone)", good({ phone: "+62811" })],
      ["bad uuid", good({ leadId: "not-a-uuid", link: `${BASE}/agency/leads/not-a-uuid` })],
      ["missing firstName", { leadId: LEAD, form: "contact", link: `${BASE}/agency/leads/${LEAD}` }],
      ["non-string firstName", good({ firstName: 7 })],
      ["firstName with a newline", good({ firstName: "Ayu\nSecond line" })],
      ["firstName that is a URL", good({ firstName: "https://evil.test" })],
      ["firstName that is a bare domain", good({ firstName: "evil.test" })],
      ["firstName with an @", good({ firstName: "ayu@evil.test" })],
      ["firstName with a digit", good({ firstName: "Ayu0811" })],
      ["firstName with a space", good({ firstName: "Ayu Putri" })],
      ["firstName over 40", good({ firstName: "A".repeat(41) })],
      ["form with a space", good({ form: "web form" })],
      ["form with a newline", good({ form: "contact\nx" })],
      ["form over 64", good({ form: "f".repeat(65) })],
      ["link to another path", good({ link: `${BASE}/agency/leads` })],
      ["link to another lead", good({ link: `${BASE}/agency/leads/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb` })],
      ["link on another host", good({ link: `https://evil.test/agency/leads/${LEAD}` })],
      ["link with the ERP host as a prefix of another host", good({ link: `${BASE}.evil.test/agency/leads/${LEAD}` })],
      ["link with a trailing suffix", good({ link: `${BASE}/agency/leads/${LEAD}?x=1` })],
      ["body is an array", [good()]],
    ])("400: %s; nothing sent", async (_n, payload) => {
      const a = app();
      const res = await post(a, payload);
      expect(res.statusCode).toBe(400);
      expect(sendText).not.toHaveBeenCalled();
      await a.close();
    });
    it("400 on an empty body", async () => {
      const a = app();
      expect((await a.inject({ method: "POST", url: "/admin/alerts/web-lead", headers: AUTH })).statusCode).toBe(400);
      await a.close();
    });
    it("accepts accented, apostrophe and hyphenated names", async () => {
      const a = app();
      for (const [i, n] of ["Zoë", "O'Brien", "Anne-Marie", "Müller"].entries()) {
        const id = `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`;
        const res = await post(a, good({ leadId: id, firstName: n, link: `${BASE}/agency/leads/${id}` }));
        expect(res.statusCode, n).toBe(200);
      }
      await a.close();
    });
  });

  describe("destination safety (never a chat the bot ingests)", () => {
    const GROUP = "120363000000000001@g.us";
    it("refuses a group listed in the registry as monitored; nothing sent", async () => {
      writeFileSync(config.groupsFile, `groups:\n  - id: "${GROUP}"\n    name: Ops\n    category: ops\n`);
      resetRegistryCache();
      setIgnored(GROUP, true); // even if also ignored: a monitored registry row is refused
      config.webLeadAlertChatId = GROUP;
      const a = app();
      const res = await post(a, good());
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "alert-destination-refused" });
      expect(sendText).not.toHaveBeenCalled();
      await a.close();
    });
    it("refuses a group that is not on the ignored list (trial mode would ingest it)", async () => {
      config.webLeadAlertChatId = GROUP; // no groups.yaml at all = trial mode
      const a = app();
      expect((await post(a, good())).statusCode).toBe(503);
      expect(sendText).not.toHaveBeenCalled();
      await a.close();
    });
    it("refuses an unlisted group in registry mode too (the registry file may be removed later)", async () => {
      writeFileSync(config.groupsFile, `groups:\n  - id: "120363000000000009@g.us"\n    name: Other\n`);
      resetRegistryCache();
      config.webLeadAlertChatId = GROUP;
      const a = app();
      expect((await post(a, good())).statusCode).toBe(503);
      expect(sendText).not.toHaveBeenCalled();
      await a.close();
    });
    it("allows a group that is explicitly on the ignored list and not in the registry", async () => {
      setIgnored(GROUP, true);
      config.webLeadAlertChatId = GROUP;
      const a = app();
      expect((await post(a, good())).statusCode).toBe(200);
      expect(sendText).toHaveBeenCalledWith(GROUP, expect.any(String));
      await a.close();
    });
    it("refuses a Telegram group (negative id) that is not ignored, allows a Telegram private chat", async () => {
      config.webLeadAlertChatId = "tg:-1001234567";
      let a = app();
      expect((await post(a, good())).statusCode).toBe(503);
      await a.close();
      config.webLeadAlertChatId = TG_DM;
      a = app();
      expect((await post(a, good())).statusCode).toBe(200);
      await a.close();
    });
    it("refuses a destination that is not a valid chat id", async () => {
      config.webLeadAlertChatId = "not a chat";
      const a = app();
      expect((await post(a, good())).statusCode).toBe(503);
      expect(sendText).not.toHaveBeenCalled();
      await a.close();
    });
    it("a refusal logs a config error with no lead data", async () => {
      const lines: string[] = [];
      config.webLeadAlertChatId = GROUP;
      const a = buildApp({ sendText } as any);
      const spy = vi.spyOn(a.log, "error").mockImplementation(((...x: unknown[]) => void lines.push(JSON.stringify(x))) as never);
      await post(a, good({ firstName: "Zebedee" }));
      expect(spy).toHaveBeenCalled();
      expect(lines.join("")).not.toContain("Zebedee");
      expect(lines.join("")).not.toContain(LEAD);
      await a.close();
    });
  });

  describe("send", () => {
    it("sends exactly the fixed template to the configured chat, nothing else", async () => {
      const a = app();
      const res = await post(a, good());
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sent: true, replayed: false });
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(DM, `New web lead from Ayu via the contact form.\n${BASE}/agency/leads/${LEAD}`);
      expect(composeWebLeadAlertText({ leadId: LEAD, firstName: "Ayu", form: "contact", link: `${BASE}/agency/leads/${LEAD}` }))
        .toBe(sendText.mock.calls[0][1]);
      await a.close();
    });
    it("the destination cannot come from the request (a chatId in the body is an unknown key)", async () => {
      const a = app();
      const res = await post(a, good({ chatId: "999@c.us" }));
      expect(res.statusCode).toBe(400);
      expect(sendText).not.toHaveBeenCalled();
      await a.close();
    });
    it("tolerates a trailing slash on the configured base URL", async () => {
      config.webLeadAlertLinkBase = `${BASE}/`;
      const a = app();
      expect((await post(a, good())).statusCode).toBe(200);
      await a.close();
    });
    it("replay of the same leadId: 200 replayed, no second send (also across a state reload)", async () => {
      const a = app();
      expect((await post(a, good())).statusCode).toBe(200);
      const again = await post(a, good());
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ sent: false, replayed: true });
      expect(sendText).toHaveBeenCalledTimes(1);
      // a restart forgets memory, not the file
      resetWebLeadAlertState();
      expect((await post(a, good())).json()).toEqual({ sent: false, replayed: true });
      expect(sendText).toHaveBeenCalledTimes(1);
      // the persisted file holds the lead id and nothing personal
      const file = readFileSync(config.webLeadAlertStateFile, "utf8");
      expect(file).toContain(LEAD);
      expect(file).not.toContain("Ayu");
      await a.close();
    });
    it("a failed send answers 502 without detail and is not remembered (a retry sends)", async () => {
      const a = app();
      sendText.mockRejectedValueOnce(new Error("waha down"));
      const failed = await post(a, good());
      expect(failed.statusCode).toBe(502);
      expect(JSON.stringify(failed.json())).not.toContain("waha");
      expect(existsSync(config.webLeadAlertStateFile)).toBe(false);
      expect((await post(a, good())).json()).toEqual({ sent: true, replayed: false });
      expect(sendText).toHaveBeenCalledTimes(2);
      await a.close();
    });
    it("a concurrent duplicate gets 409 while the first is still sending", async () => {
      let release!: () => void;
      sendText.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
      const a = app();
      const first = post(a, good());
      await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
      expect((await post(a, good())).statusCode).toBe(409);
      release();
      expect((await first).statusCode).toBe(200);
      await a.close();
    });
  });

  describe("through the real surface router", () => {
    beforeEach(() => {
      resetRateLimiter(); resetOutboundCeilingCounters(); resetOutboundHalt(); resetLoopGuard();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });
    const stubs = () => {
      const wa = { sendText: vi.fn(async () => {}) };
      const tg = { sendText: vi.fn(async () => {}) };
      return { wa, tg, router: new SurfaceRouter(wa as any, tg as any) };
    };
    it("a tg: destination leaves through the Telegram transport, a WhatsApp id through WAHA", async () => {
      const { wa, tg, router } = stubs();
      config.webLeadAlertChatId = TG_DM;
      let a = buildApp(router);
      expect((await post(a, good())).statusCode).toBe(200);
      await a.close();
      expect(tg.sendText).toHaveBeenCalledTimes(1);
      expect(wa.sendText).not.toHaveBeenCalled();
      config.webLeadAlertChatId = DM;
      const id2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      a = buildApp(router);
      expect((await post(a, good({ leadId: id2, link: `${BASE}/agency/leads/${id2}` }))).statusCode).toBe(200);
      await a.close();
      expect(wa.sendText).toHaveBeenCalledTimes(1);
    });
    it("the outbound halt blocks it (502) and the alert is not remembered", async () => {
      const { tg, router } = stubs();
      config.webLeadAlertChatId = TG_DM;
      setOutboundHalt(true);
      const a = buildApp(router);
      expect((await post(a, good())).statusCode).toBe(502);
      expect(tg.sendText).not.toHaveBeenCalled();
      setOutboundHalt(false);
      expect((await post(a, good())).statusCode).toBe(200);
      await a.close();
    });
  });

  describe("never persisted as chat history", () => {
    it("no history-store function is called by the route, on send, replay or any rejection", async () => {
      const a = app();
      await post(a, good()); // sent
      await post(a, good()); // replay
      await post(a, good({ extra: 1 })); // 400
      await post(a, good(), {}); // 401
      config.webLeadAlertChatId = "";
      await post(a, good()); // 503
      expect(storeCalls).toEqual([]);
      await a.close();
    });
    it("the digest read path never sees the alert text", async () => {
      const { getMessages, getMessagesPage } = await import("./store");
      const a = app();
      await post(a, good());
      storeCalls.length = 0;
      expect(await getMessages(DM)).toEqual([]);
      expect(await getMessagesPage(DM, { limit: 50 })).toEqual([]);
      // control: the spy does record store calls, so the empty assertions above are meaningful
      expect(storeCalls).toEqual(["getMessages", "getMessagesPage"]);
      await a.close();
    });
  });
});
