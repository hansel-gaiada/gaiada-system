// M6-P6i — the claim's `search_properties` rule (site-property-link.ts), as the pure planner. No database. The consent gate in
// one table: a client's property is NEVER verified by a claim; an internal one is verified only when the D36 sentinel exists;
// an existing property is linked and left as it is; a property that belongs to another client refuses.
import { describe, expect, it } from "vitest";
import { planPropertyLink, type PropertyLinkState } from "./site-property-link";

const SENTINEL = "5e571e11-0000-4000-8000-000000000001";
const CLIENT = "c11e0700-0000-4000-8000-000000000002";
const OTHER_CLIENT = "c11e0700-0000-4000-8000-000000000003";
const PROPERTY = "9a0b0000-0000-4000-8000-000000000004";

const state = (over: Partial<PropertyLinkState>): PropertyLinkState => ({
  siteClientId: null, siteClientIsInternal: false, sentinelIds: [], existing: null, ...over,
});

describe("planPropertyLink", () => {
  describe("a CLIENT site", () => {
    it("creates the property under the client, UNVERIFIED (internal: false): the claim never opens the consent gate", () => {
      expect(planPropertyLink(state({ siteClientId: CLIENT }))).toEqual({ action: "insert", clientId: CLIENT, internal: false });
    });

    it("is the same with an internal sentinel present: a client's domain is never filed under it", () => {
      expect(planPropertyLink(state({ siteClientId: CLIENT, sentinelIds: [SENTINEL] }))).toEqual({ action: "insert", clientId: CLIENT, internal: false });
    });

    it("links an existing property of the same client (its verified_at is left alone, whatever it is)", () => {
      for (const verifiedAt of [null, new Date("2026-10-01T00:00:00Z")]) {
        expect(planPropertyLink(state({ siteClientId: CLIENT, existing: { id: PROPERTY, clientId: CLIENT, verifiedAt } }))).toEqual({
          action: "link", propertyId: PROPERTY, internal: false,
        });
      }
    });

    it("refuses when the domain already belongs to ANOTHER client (one domain, one owner)", () => {
      expect(planPropertyLink(state({ siteClientId: CLIENT, existing: { id: PROPERTY, clientId: OTHER_CLIENT, verifiedAt: null } }))).toEqual({
        action: "conflict", propertyId: PROPERTY, ownerClientId: OTHER_CLIENT,
      });
    });

    it("refuses when the domain already belongs to the INTERNAL sentinel: a client cannot take over an internal domain", () => {
      expect(planPropertyLink(state({ siteClientId: CLIENT, sentinelIds: [SENTINEL], existing: { id: PROPERTY, clientId: SENTINEL, verifiedAt: new Date() } }))).toMatchObject({
        action: "conflict",
      });
    });
  });

  describe("an INTERNAL site (no client on the row)", () => {
    it("with the sentinel: creates the property under the sentinel, VERIFIED (D36 a and b)", () => {
      expect(planPropertyLink(state({ sentinelIds: [SENTINEL] }))).toEqual({ action: "insert", clientId: SENTINEL, internal: true });
    });

    it("WITHOUT a sentinel: creates nothing (an unverified row is not a stand-in, and a property needs an owner)", () => {
      expect(planPropertyLink(state({ sentinelIds: [] }))).toEqual({ action: "skip", reason: "no_internal_sentinel" });
    });

    it("with MORE THAN ONE sentinel: creates nothing and says so (the M5-G0 script's own refusal)", () => {
      expect(planPropertyLink(state({ sentinelIds: [SENTINEL, "5e571e11-0000-4000-8000-000000000009"] }))).toEqual({ action: "skip", reason: "ambiguous_internal_sentinel" });
    });

    it("links the sentinel's existing property, and refuses one owned by a real client", () => {
      expect(planPropertyLink(state({ sentinelIds: [SENTINEL], existing: { id: PROPERTY, clientId: SENTINEL, verifiedAt: new Date() } }))).toEqual({
        action: "link", propertyId: PROPERTY, internal: true,
      });
      expect(planPropertyLink(state({ sentinelIds: [SENTINEL], existing: { id: PROPERTY, clientId: CLIENT, verifiedAt: null } }))).toMatchObject({ action: "conflict" });
    });
  });

  describe("a site whose client IS the internal sentinel (after the P3b backfill)", () => {
    it("is internal: verified, under that client, even when it is the only sentinel", () => {
      expect(planPropertyLink(state({ siteClientId: SENTINEL, siteClientIsInternal: true, sentinelIds: [SENTINEL] }))).toEqual({
        action: "insert", clientId: SENTINEL, internal: true,
      });
    });

    it("needs no lookup of the sentinel list: the row's own client is the owner", () => {
      expect(planPropertyLink(state({ siteClientId: SENTINEL, siteClientIsInternal: true, sentinelIds: [] }))).toEqual({
        action: "insert", clientId: SENTINEL, internal: true,
      });
    });
  });
});
