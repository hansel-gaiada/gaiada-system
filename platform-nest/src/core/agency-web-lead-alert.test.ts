// M5-L5 / M5-L5b — the staff alert for a new web lead. No database: both senders are injected.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import {
  alertStaffOfWebLead, buildWebLeadAlert, buildWebLeadChatBody, defaultChatSender, firstNameOf, webLeadAlertRecipients,
  webLeadChatEnabled, WEB_LEAD_ALERT_TYPE, type WebLeadChatBody,
} from "./agency-web-lead-alert";
import { config } from "../config";

const LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const TENANT = "33333333-3333-4333-8333-333333333333";

const bot0 = { ...config.services.bot };
beforeEach(() => { process.env.AGENCY_WEB_LEAD_ALERT_USER_IDS = `${U1}, ${U2},not-a-uuid,${U1}`; });
afterEach(() => {
  delete process.env.AGENCY_WEB_LEAD_ALERT_USER_IDS;
  delete process.env.AGENCY_WEB_LEAD_ALERT_CHAT;
  Object.assign(config.services.bot, bot0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const enableChat = () => {
  process.env.AGENCY_WEB_LEAD_ALERT_CHAT = "1";
  config.services.bot.url = "http://bot:3001/";
  config.services.bot.token = "tok";
};

describe("firstNameOf", () => {
  it("first token, or 'someone'", () => {
    expect(firstNameOf("Zebedee Quuxington")).toBe("Zebedee");
    expect(firstNameOf("  Ayu  ")).toBe("Ayu");
    expect(firstNameOf(null)).toBe("someone");
    expect(firstNameOf("   ")).toBe("someone");
  });
  it("a token that is not a plain name is replaced, never partially cleaned", () => {
    for (const t of ["https://evil.test/x", "evil.test", "ayu@leak.test", "+628110000", "0811", "<b>x</b>", "a_b"]) {
      expect(firstNameOf(`${t} Putri`), t).toBe("someone");
    }
    expect(firstNameOf("Ayu, Putri")).toBe("Ayu");
    expect(firstNameOf("O'Brien Smith")).toBe("O'Brien");
    expect(firstNameOf("Zoë")).toBe("Zoë");
    expect(firstNameOf("A".repeat(60))).toBe("A".repeat(40));
  });
});

describe("buildWebLeadAlert — only id, first name, form and link", () => {
  it("carries the allowed fields and none of the personal data", () => {
    const p = buildWebLeadAlert({ leadId: LEAD, contactName: "Zebedee Quuxington", originForm: "contact" });
    const all = JSON.stringify(p);
    expect(all).toContain(LEAD);
    expect(all).toContain("Zebedee");
    expect(all).toContain("contact");
    expect(p.href).toBe(`/agency/leads/${LEAD}`);
    // the surname, email, phone, message, org and attribution must not appear
    for (const leak of ["Quuxington", "@", "+62", "secret project", "utm_", "gclid", "landing"]) expect(all).not.toContain(leak);
    expect(Object.keys(p).sort()).toEqual(["body", "entityId", "entityType", "href", "severity", "title"]);
  });
  it("the builder's signature cannot accept email/phone/message (inputs are only id, name, form)", () => {
    const p = buildWebLeadAlert({
      leadId: LEAD, contactName: "Ayu", originForm: "audit",
      ...({ contactEmail: "a@leak.test", contactPhone: "+62 811", message: "hello secret" } as object),
    } as never);
    const all = JSON.stringify(p);
    for (const leak of ["a@leak.test", "+62 811", "hello secret"]) expect(all).not.toContain(leak);
  });
});

describe("alertStaffOfWebLead", () => {
  it("sends once to the de-duplicated, uuid-only configured recipients", async () => {
    const send = vi.fn(async () => {});
    await alertStaffOfWebLead(TENANT, { leadId: LEAD, contactName: "Ayu Putri", originForm: "contact" }, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(TENANT, [U1, U2], WEB_LEAD_ALERT_TYPE, expect.objectContaining({ entityId: LEAD }));
  });
  it("sends nothing when no destination is configured (fail-closed)", async () => {
    delete process.env.AGENCY_WEB_LEAD_ALERT_USER_IDS;
    expect(webLeadAlertRecipients()).toEqual([]);
    const send = vi.fn(async () => {});
    await alertStaffOfWebLead(TENANT, { leadId: LEAD, contactName: "Ayu", originForm: "contact" }, send);
    expect(send).not.toHaveBeenCalled();
  });
  it("never throws when the sender fails, and logs no personal data", async () => {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, "warn").mockImplementation((...a: unknown[]) => { lines.push(JSON.stringify(a)); });
    const send = vi.fn(async () => { throw new Error("boom zebedee@leak.test"); });
    await expect(alertStaffOfWebLead(TENANT, { leadId: LEAD, contactName: "Zebedee", originForm: "contact" }, send)).resolves.toBeUndefined();
    expect(lines.join("")).toContain(LEAD);
    expect(lines.join("")).not.toContain("leak.test");
  });
});

describe("web-lead chat relay (M5-L5b)", () => {
  const lead = { leadId: LEAD, contactName: "Ayu Putri", originForm: "contact" };
  const LINK = `${config.mail.linkBaseUrl}/agency/leads/${LEAD}`;

  it("is off unless the flag is exactly 1 AND the bot is configured", () => {
    expect(webLeadChatEnabled()).toBe(false);
    config.services.bot.url = "http://bot:3001";
    config.services.bot.token = "tok";
    expect(webLeadChatEnabled()).toBe(false); // bot configured, flag unset: bell only
    for (const v of ["", "0", "true", "yes"]) {
      process.env.AGENCY_WEB_LEAD_ALERT_CHAT = v;
      expect(webLeadChatEnabled(), v).toBe(false);
    }
    process.env.AGENCY_WEB_LEAD_ALERT_CHAT = "1";
    expect(webLeadChatEnabled()).toBe(true);
    config.services.bot.token = "";
    expect(webLeadChatEnabled()).toBe(false); // flag set, no token
  });

  it("not configured: only the bell is sent", async () => {
    const send = vi.fn(async () => {});
    const chat = vi.fn(async (_b: WebLeadChatBody) => {});
    await alertStaffOfWebLead(TENANT, lead, send, chat);
    expect(send).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
  });

  it("configured: both channels, the chat body is exactly the four fields", async () => {
    enableChat();
    const send = vi.fn(async () => {});
    const chat = vi.fn(async (_b: WebLeadChatBody) => {});
    await alertStaffOfWebLead(TENANT, lead, send, chat);
    expect(send).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith({ leadId: LEAD, firstName: "Ayu", form: "contact", link: LINK });
    expect(Object.keys(chat.mock.calls[0][0] as object).sort()).toEqual(["firstName", "form", "leadId", "link"]);
  });

  it("the channels are independent: chat without bell recipients", async () => {
    enableChat();
    delete process.env.AGENCY_WEB_LEAD_ALERT_USER_IDS;
    const send = vi.fn(async () => {});
    const chat = vi.fn(async (_b: WebLeadChatBody) => {});
    await alertStaffOfWebLead(TENANT, lead, send, chat);
    expect(send).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("a chat failure never affects the bell or the lead; the log line has the lead id and the error name only", async () => {
    enableChat();
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, "warn").mockImplementation((...a: unknown[]) => { lines.push(JSON.stringify(a)); });
    const send = vi.fn(async () => {});
    const chat = vi.fn(async () => { throw Object.assign(new Error("boom zebedee@leak.test +62811"), { name: "BotHttp503" }); });
    await expect(alertStaffOfWebLead(TENANT, { ...lead, contactName: "Zebedee Q" }, send, chat)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1); // the bell went out and was unaffected
    const log = lines.join("");
    expect(log).toContain(LEAD);
    expect(log).toContain("BotHttp503");
    for (const leak of ["leak.test", "+62811", "Zebedee", "boom"]) expect(log).not.toContain(leak);
  });

  it("a bell failure does not stop the chat channel", async () => {
    enableChat();
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const send = vi.fn(async () => { throw new Error("db down"); });
    const chat = vi.fn(async (_b: WebLeadChatBody) => {});
    await alertStaffOfWebLead(TENANT, lead, send, chat);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("no email, phone, message, org or attribution reaches either channel, even from a lead that has them", async () => {
    enableChat();
    const rich = {
      ...lead, contactName: "Zebedee Quuxington",
      contactEmail: "zebedee@leak.test", contactPhone: "+62 811 000", message: "my secret project", orgName: "Quux Holdings",
      attribution: { utm_source: "google", gclid: "abc", landing: "/landing/" },
    };
    const send = vi.fn(async () => {});
    const chat = vi.fn(async (_b: WebLeadChatBody) => {});
    await alertStaffOfWebLead(TENANT, rich as never, send, chat);
    const all = JSON.stringify([send.mock.calls, chat.mock.calls]);
    for (const leak of ["Quuxington", "leak.test", "+62 811", "secret project", "Quux Holdings", "utm_", "gclid", "google", "landing", "attribution"]) {
      expect(all, leak).not.toContain(leak);
    }
    expect(buildWebLeadChatBody(rich as never)).toEqual({ leadId: LEAD, firstName: "Zebedee", form: "contact", link: LINK });
  });

  it("a form key the bot would refuse is replaced, so our own value is never rejected", () => {
    for (const f of [null, "web form", "x y", `${"a".repeat(80)} z`]) {
      const ok = f !== null && /^[A-Za-z0-9_.:-]{1,64}$/.test(f.slice(0, 64));
      expect(buildWebLeadChatBody({ ...lead, originForm: f }).form, String(f)).toBe(ok ? f!.slice(0, 64) : "web-form");
    }
    expect(buildWebLeadChatBody({ ...lead, originForm: "contact" }).form).toBe("contact");
  });

  it("both channels share one allow-list: same first name, form and link", () => {
    const p = buildWebLeadAlert({ leadId: LEAD, contactName: "Ayu Putri", originForm: "audit" });
    const c = buildWebLeadChatBody({ leadId: LEAD, contactName: "Ayu Putri", originForm: "audit" });
    expect(p.body).toBe(`New web lead ${LEAD}: ${c.firstName} via the ${c.form} form. ${c.link}`);
  });

  describe("defaultChatSender (the real HTTP call, fetch stubbed)", () => {
    it("POSTs the four fields as JSON to <bot>/admin/alerts/web-lead with the bearer token", async () => {
      enableChat();
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sent: true }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      await defaultChatSender(buildWebLeadChatBody(lead));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://bot:3001/admin/alerts/web-lead");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
      expect(JSON.parse(init.body as string)).toEqual({ leadId: LEAD, firstName: "Ayu", form: "contact", link: LINK });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
    it("a non-2xx throws an error named for the status (never the response body)", async () => {
      enableChat();
      vi.stubGlobal("fetch", vi.fn(async () => new Response("alert-destination-unset zebedee", { status: 503 })));
      await expect(defaultChatSender(buildWebLeadChatBody(lead))).rejects.toMatchObject({ name: "BotHttp503" });
    });
    it("end to end through alertStaffOfWebLead: a bot 503 is logged and swallowed", async () => {
      enableChat();
      const lines: string[] = [];
      vi.spyOn(Logger.prototype, "warn").mockImplementation((...a: unknown[]) => { lines.push(JSON.stringify(a)); });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
      await expect(alertStaffOfWebLead(TENANT, lead, vi.fn(async () => {}))).resolves.toBeUndefined();
      expect(lines.join("")).toContain("BotHttp503");
    });
    it("a hung bot is aborted by the short timeout", async () => {
      enableChat();
      vi.useFakeTimers();
      try {
        vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_r, rej) => {
          init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })));
        const p = defaultChatSender(buildWebLeadChatBody(lead));
        const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
        await vi.advanceTimersByTimeAsync(5001);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
