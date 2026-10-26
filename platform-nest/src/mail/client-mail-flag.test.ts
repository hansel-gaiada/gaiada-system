// PGL-09 (PV-D47) — the ONE client-mail flag, with no database. Runs everywhere.
//
//   * how the flag is read: `CLIENT_MAIL_ENABLED`, with `CONVERSATION_CLIENT_MAIL_ENABLED` as a read-only alias for one
//     release (either being exactly "1" turns client mail on; anything else, the empty string a compose `${VAR:-}`
//     passthrough writes included, is off);
//   * the allow-list is split into two audiences that partition it, so a new type must pick a side;
//   * flag OFF means `mailIntake` returns BEFORE any lookup, for EVERY client type: the database module is mocked to throw
//     if it is touched at all, and `enqueueMail` must never be called (so there is no `mail_log` row to write).
//
// The DB-backed half (who is mailed, which rows exist) is `client-mail.db.test.ts`.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const probe = vi.hoisted(() => ({ dbTouched: 0, enqueued: 0 }));

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  const touched = () => {
    probe.dbTouched += 1;
    throw new Error("the database was touched while client mail is OFF");
  };
  return { ...actual, withGlobal: touched, withMailContext: touched, withTenants: touched };
});
vi.mock("./queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue")>();
  return {
    ...actual,
    enqueueMail: vi.fn(async () => {
      probe.enqueued += 1;
      return { skipped: false as const, id: "x", status: "queued" as const };
    }),
  };
});

import { config, readClientMailEnabled } from "../config";
import {
  clientMailNotificationTypes, mailAllowlistedNotificationTypes, mailIntake, staffMailNotificationTypes,
} from "./intake";

describe("PGL-09: how the client-mail flag is read", () => {
  it("CLIENT_MAIL_ENABLED=1 alone turns it on", () => {
    expect(readClientMailEnabled({ CLIENT_MAIL_ENABLED: "1" })).toBe(true);
  });

  it("the old CONVERSATION_CLIENT_MAIL_ENABLED=1 ALONE still turns it on (the one-release alias)", () => {
    expect(readClientMailEnabled({ CONVERSATION_CLIENT_MAIL_ENABLED: "1" })).toBe(true);
  });

  it("either one being 1 is enough, and both together is on", () => {
    expect(readClientMailEnabled({ CLIENT_MAIL_ENABLED: "0", CONVERSATION_CLIENT_MAIL_ENABLED: "1" })).toBe(true);
    expect(readClientMailEnabled({ CLIENT_MAIL_ENABLED: "1", CONVERSATION_CLIENT_MAIL_ENABLED: "0" })).toBe(true);
    expect(readClientMailEnabled({ CLIENT_MAIL_ENABLED: "1", CONVERSATION_CLIENT_MAIL_ENABLED: "1" })).toBe(true);
  });

  it("neither set, both 0, empty (a compose ${VAR:-} passthrough), 'true', 'yes' and ' 1' are all OFF", () => {
    expect(readClientMailEnabled({})).toBe(false);
    expect(readClientMailEnabled({ CLIENT_MAIL_ENABLED: "0", CONVERSATION_CLIENT_MAIL_ENABLED: "0" })).toBe(false);
    expect(readClientMailEnabled({ CLIENT_MAIL_ENABLED: "", CONVERSATION_CLIENT_MAIL_ENABLED: "" })).toBe(false);
    for (const v of ["true", "yes", "on", " 1", "1 ", "01"]) {
      expect(readClientMailEnabled({ CLIENT_MAIL_ENABLED: v }), `CLIENT_MAIL_ENABLED=${JSON.stringify(v)}`).toBe(false);
      expect(readClientMailEnabled({ CONVERSATION_CLIENT_MAIL_ENABLED: v }), `alias=${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("config.mail.clientMailEnabled is the single value the intake reads, and the old per-conversation field is gone", () => {
    expect(typeof config.mail.clientMailEnabled).toBe("boolean");
    expect("conversationClientMailEnabled" in config.mail).toBe(false);
  });
});

describe("PGL-09: the allow-list has two audiences that partition it", () => {
  it("every allow-listed type is declared staff or client, never both, never neither", () => {
    const all = mailAllowlistedNotificationTypes().sort();
    const staff = staffMailNotificationTypes();
    const client = clientMailNotificationTypes();
    expect([...staff, ...client].sort()).toEqual(all);
    expect(staff.filter((t) => client.includes(t))).toEqual([]);
  });

  it("the client types are exactly the gate, the conversation message, the contract and the invoice", () => {
    expect(clientMailNotificationTypes().sort()).toEqual([
      "contract.sent", "conversation.message.staff", "invoice.issued", "pipeline.gate.opened",
    ]);
  });

  it("the staff types are unchanged: the approval request, and only that", () => {
    expect(staffMailNotificationTypes()).toEqual(["approval.requested"]);
  });
});

describe("PGL-09: flag OFF, every client type returns before any lookup (no query, no enqueue, so no mail_log row)", () => {
  const savedEnabled = config.mail.enabled;
  const savedClient = config.mail.clientMailEnabled;
  beforeEach(() => {
    probe.dbTouched = 0;
    probe.enqueued = 0;
    config.mail.enabled = true; // the master gate is ON: only the client flag is under test
    config.mail.clientMailEnabled = false;
  });
  afterEach(() => {
    config.mail.enabled = savedEnabled;
    config.mail.clientMailEnabled = savedClient;
  });

  const ENTITY = "11111111-1111-1111-1111-111111111111";
  for (const type of ["pipeline.gate.opened", "conversation.message.staff", "contract.sent", "invoice.issued"]) {
    it(`${type}: nothing is read and nothing is enqueued`, async () => {
      await mailIntake({
        notificationId: "22222222-2222-2222-2222-222222222222",
        tenantId: "33333333-3333-3333-3333-333333333333",
        userId: "44444444-4444-4444-4444-444444444444",
        type,
        payload: { title: "t", href: "/portal/x", entityType: "x", entityId: ENTITY },
      });
      expect(probe.dbTouched).toBe(0);
      expect(probe.enqueued).toBe(0);
    });
  }

  it("the proof is not vacuous: the SAME call with the flag ON does reach the database", async () => {
    config.mail.clientMailEnabled = true;
    await expect(
      mailIntake({
        notificationId: "22222222-2222-2222-2222-222222222222",
        tenantId: "33333333-3333-3333-3333-333333333333",
        userId: "44444444-4444-4444-4444-444444444444",
        type: "invoice.issued",
        payload: { title: "t", href: "/portal/invoices/1", entityType: "invoice", entityId: ENTITY },
      }),
    ).rejects.toThrow(/database was touched/);
    expect(probe.dbTouched).toBeGreaterThan(0);
  });

  it("a staff type is NOT behind the client flag: approval.requested reaches the database with the flag OFF", async () => {
    await expect(
      mailIntake({
        notificationId: "22222222-2222-2222-2222-222222222222",
        tenantId: "33333333-3333-3333-3333-333333333333",
        userId: "44444444-4444-4444-4444-444444444444",
        type: "approval.requested",
        payload: { title: "t", href: "/approvals", origin: "hr" },
      }),
    ).rejects.toThrow(/database was touched/);
  });

  it("with the MASTER gate off, nothing is read even with the client flag on", async () => {
    config.mail.enabled = false;
    config.mail.clientMailEnabled = true;
    await mailIntake({
      notificationId: "22222222-2222-2222-2222-222222222222",
      tenantId: "33333333-3333-3333-3333-333333333333",
      userId: "44444444-4444-4444-4444-444444444444",
      type: "invoice.issued",
      payload: { title: "t", href: "/portal/invoices/1", entityType: "invoice", entityId: ENTITY },
    });
    expect(probe.dbTouched).toBe(0);
    expect(probe.enqueued).toBe(0);
  });
});
