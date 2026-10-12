// M5-V3-a -- consent.status: the pure parts (body parser, registry entry). No database, no Nest.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { parseConsentStatusBody, CONSENT_STATUS_MAX_IDS } from "../src/control/consent/consent-status-body";
import { COMMAND_REGISTRY, EDITORIAL_COMMANDS, CLIENT_EDITOR_COMMANDS } from "../src/control/command-types";
import { ControlProblem } from "../src/control/content/content-problem";

const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
const refuses = (raw: unknown) => {
  try {
    parseConsentStatusBody(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(ControlProblem);
    expect((e as ControlProblem).getStatus()).toBe(400);
    return true;
  }
  return false;
};

describe("consent.status body parser", () => {
  it("accepts 1 and exactly 100 ids", () => {
    expect(parseConsentStatusBody({ consentIds: ids(1) }).consentIds).toHaveLength(1);
    expect(parseConsentStatusBody({ consentIds: ids(CONSENT_STATUS_MAX_IDS) }).consentIds).toHaveLength(100);
  });
  it("101 ids is a 400, even when they repeat", () => {
    expect(refuses({ consentIds: ids(101) })).toBe(true);
    const one = randomUUID();
    expect(refuses({ consentIds: Array.from({ length: 101 }, () => one) })).toBe(true);
  });
  it("refuses an empty list, a missing list, a non-array, a non-uuid entry and a non-string entry", () => {
    expect(refuses({ consentIds: [] })).toBe(true);
    expect(refuses({})).toBe(true);
    expect(refuses({ consentIds: randomUUID() })).toBe(true);
    expect(refuses({ consentIds: [randomUUID(), "not-a-uuid"] })).toBe(true);
    expect(refuses({ consentIds: [randomUUID(), 7] })).toBe(true);
  });
  it("refuses a non-object body and an unknown member", () => {
    expect(refuses(null)).toBe(true);
    expect(refuses([randomUUID()])).toBe(true);
    expect(refuses("x")).toBe(true);
    expect(refuses({ consentIds: ids(1), includeAll: true })).toBe(true);
  });
  it("lower-cases and de-duplicates, keeping first-seen order", () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(parseConsentStatusBody({ consentIds: [a.toUpperCase(), b, a] }).consentIds).toEqual([a, b]);
  });
  it("siteSlug is optional, and must be a non-empty string when present", () => {
    expect(parseConsentStatusBody({ consentIds: ids(1) }).siteSlug).toBeNull();
    expect(parseConsentStatusBody({ siteSlug: "gaiada", consentIds: ids(1) }).siteSlug).toBe("gaiada");
    expect(refuses({ siteSlug: "", consentIds: ids(1) })).toBe(true);
    expect(refuses({ siteSlug: 5, consentIds: ids(1) })).toBe(true);
  });
});

describe("consent.status in the command registry", () => {
  it("is read / webdesk:read, not job-tracked", () => {
    expect(COMMAND_REGISTRY["consent.status"]).toMatchObject({ command: "consent.status", impactClass: "read", scope: "webdesk:read", jobTracked: false });
  });
  it("is not an editorial command and not on the client-editor allow-list", () => {
    expect(EDITORIAL_COMMANDS.has("consent.status")).toBe(false);
    expect(CLIENT_EDITOR_COMMANDS.has("consent.status")).toBe(false);
  });
});
