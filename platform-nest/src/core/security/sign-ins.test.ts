// DW-7h (BFF §52.6) — mapping Keycloak events to this company's members. Pure.
import { describe, it, expect } from "vitest";
import type { KeycloakEvent } from "../keycloak-admin";
import { mapSignInEvents, missingEventTypes, type SignInLookups } from "./sign-ins";

const T0 = Date.parse("2026-10-15T12:00:00Z");
const ev = (minutesAgo: number, over: Partial<KeycloakEvent> = {}): KeycloakEvent => ({
  time: T0 - minutesAgo * 60_000, type: "LOGIN", userId: "kc-a", ipAddress: "203.0.113.9", error: null,
  username: "a@ex.com", sessionId: null, ...over,
});

const lookups = (): SignInLookups => ({
  byKeycloakId: new Map([
    ["kc-a", { id: "u-a", email: "a@ex.com" }],
    ["kc-b", { id: "u-b", email: "b@ex.com" }],
    ["kc-other", { id: "u-other", email: "other@else.com" }],
  ]),
  byEmail: new Map([
    ["a@ex.com", { id: "u-a", email: "a@ex.com" }],
    ["b@ex.com", { id: "u-b", email: "b@ex.com" }],
    ["other@else.com", { id: "u-other", email: "other@else.com" }],
    ["linked@ex.com", { id: "u-linked", email: "linked@ex.com" }],
  ]),
  memberIds: new Set(["u-a", "u-b", "u-linked"]),
});
const run = (events: KeycloakEvent[], sinceMinutes = 24 * 60) =>
  mapSignInEvents(events, lookups(), { sinceMs: T0 - sinceMinutes * 60_000 });

describe("mapSignInEvents", () => {
  it("lists a member's events newest first with the three types named for the UI", () => {
    const r = run([
      ev(30, { type: "LOGOUT" }),
      ev(10, { type: "LOGIN" }),
      ev(20, { type: "LOGIN_ERROR", error: "invalid_user_credentials" }),
    ]);
    expect(r.events.map((e) => [e.type, e.error])).toEqual([
      ["sign_in", null], ["failed", "invalid_user_credentials"], ["sign_out", null],
    ]);
    expect(r.events[0]).toMatchObject({ userId: "u-a", email: "a@ex.com", ip: "203.0.113.9" });
    expect(r.summary).toMatchObject({ signIns: 1, failed: 1 });
  });

  it("🔴 another company's staff is not listed, and not counted as an unknown account", () => {
    const r = run([ev(5, { type: "LOGIN_ERROR", userId: "kc-other", username: "other@else.com" }), ev(6, { userId: "kc-other" })]);
    expect(r.events).toEqual([]);
    expect(r.unknownAccounts.failed).toBe(0);
    expect(r.failed).toEqual([]);
  });

  it("maps by the typed email when the event carries no Keycloak id (a user Keycloak never found)", () => {
    const r = run([ev(5, { type: "LOGIN_ERROR", userId: null, username: "B@Ex.com", error: "invalid_user_credentials" })]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ userId: "u-b", email: "b@ex.com", type: "failed" });
  });

  it("🔴 a failed sign-in matching no ERP user is counted but never named", () => {
    const r = run([
      ev(5, { type: "LOGIN_ERROR", userId: null, username: "ghost@nowhere.test", error: "user_not_found" }),
      ev(6, { type: "LOGIN_ERROR", userId: null, username: "hunter2-typed-as-name", error: "user_not_found" }),
    ]);
    expect(r.unknownAccounts).toEqual({ failed: 2 });
    expect(r.events).toEqual([]);
    expect(r.summary.failed).toBe(0);
    const text = JSON.stringify(r);
    expect(text).not.toContain("ghost");
    expect(text).not.toContain("hunter2");
    expect(r.failed).toHaveLength(2);
    expect(r.failed.every((f) => f.userId === null && f.email === null)).toBe(true);
  });

  it("an unmatched LOGIN or LOGOUT is ignored (only failures from unknown accounts matter)", () => {
    const r = run([ev(5, { type: "LOGIN", userId: "kc-zzz", username: "zzz@x.test" }), ev(6, { type: "LOGOUT", userId: null, username: null })]);
    expect(r.events).toEqual([]);
    expect(r.unknownAccounts.failed).toBe(0);
  });

  it("summarises failures by account (members) and by address (members and unknown accounts together)", () => {
    const events = [
      ...[1, 2, 3].map((m) => ev(m, { type: "LOGIN_ERROR", error: "e" })),
      ev(4, { type: "LOGIN_ERROR", userId: "kc-b", username: "b@ex.com", ipAddress: "203.0.113.50", error: "e" }),
      ev(5, { type: "LOGIN_ERROR", userId: null, username: "ghost@x.test", ipAddress: "203.0.113.9", error: "e" }),
    ];
    const r = run(events);
    expect(r.summary.failed).toBe(4);
    expect(r.summary.failedByAccount).toEqual([
      { userId: "u-a", email: "a@ex.com", count: 3 },
      { userId: "u-b", email: "b@ex.com", count: 1 },
    ]);
    expect(r.summary.failedByIp).toEqual([
      { ip: "203.0.113.9", count: 4 },
      { ip: "203.0.113.50", count: 1 },
    ]);
  });

  it("drops events older than the window, and keeps an event with no address out of the address summary", () => {
    const r = run([ev(60 * 25, { type: "LOGIN_ERROR" }), ev(5, { type: "LOGIN_ERROR", ipAddress: null })]);
    expect(r.summary.failed).toBe(1);
    expect(r.summary.failedByIp).toEqual([]);
    expect(r.failed).toHaveLength(1);
  });

  it("caps the listed events but not the summary", () => {
    const events = Array.from({ length: 12 }, (_, i) => ev(i + 1));
    const r = mapSignInEvents(events, lookups(), { sinceMs: 0, limit: 5 });
    expect(r.events).toHaveLength(5);
    expect(r.summary.signIns).toBe(12);
  });
});

describe("missingEventTypes", () => {
  it("names the needed types an explicit list leaves out, and does not judge an empty (default) list", () => {
    expect(missingEventTypes(["LOGIN", "LOGIN_ERROR", "LOGOUT", "REGISTER"])).toEqual([]);
    expect(missingEventTypes(["LOGIN"])).toEqual(["LOGIN_ERROR", "LOGOUT"]);
    expect(missingEventTypes([])).toEqual([]);
  });
});
