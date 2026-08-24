import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { INTERNAL_CLIENT, clientFilterSql, parseClientFilter } from "./client-filter";

// CC-1. These tests exist mostly to pin the FAIL-OPEN contract, which is the one property of this
// module a future refactor is likely to "fix" into fail-closed by analogy with portal-scope.ts.

describe("parseClientFilter", () => {
  const UUID = "019fb652-c708-71f8-a348-91247b5abf2e";

  it("treats an absent or blank parameter as 'all'", () => {
    expect(parseClientFilter(undefined)).toEqual({ kind: "all" });
    expect(parseClientFilter(null)).toEqual({ kind: "all" });
    expect(parseClientFilter("")).toEqual({ kind: "all" });
    expect(parseClientFilter("   ")).toEqual({ kind: "all" });
  });

  it("resolves a uuid to that client", () => {
    expect(parseClientFilter(UUID)).toEqual({ kind: "client", clientId: UUID });
    expect(parseClientFilter(`  ${UUID}  `)).toEqual({ kind: "client", clientId: UUID });
    expect(parseClientFilter(UUID.toUpperCase())).toEqual({ kind: "client", clientId: UUID.toUpperCase() });
  });

  it("resolves the reserved word to the internal scope, case-insensitively", () => {
    expect(parseClientFilter(INTERNAL_CLIENT)).toEqual({ kind: "internal" });
    expect(parseClientFilter("Internal")).toEqual({ kind: "internal" });
    expect(parseClientFilter("INTERNAL")).toEqual({ kind: "internal" });
  });

  // THE load-bearing case. A filter that fails closed hides real work and is indistinguishable from
  // "there is nothing here"; a boundary fails closed, and this is not a boundary. If this test is
  // ever changed to expect a throw or an empty result, read the module header first.
  it("FAILS OPEN on garbage rather than denying or throwing", () => {
    expect(parseClientFilter("not-a-uuid")).toEqual({ kind: "all" });
    expect(parseClientFilter("' OR 1=1 --")).toEqual({ kind: "all" });
    expect(parseClientFilter(42)).toEqual({ kind: "all" });
    expect(parseClientFilter({})).toEqual({ kind: "all" });
  });

  it("throws only when a caller explicitly asks for strict parsing", () => {
    expect(() => parseClientFilter("not-a-uuid", true)).toThrow(BadRequestException);
    // `internal` and a real uuid stay valid under strict — strict narrows the GARBAGE case only.
    expect(parseClientFilter(INTERNAL_CLIENT, true)).toEqual({ kind: "internal" });
    expect(parseClientFilter(UUID, true)).toEqual({ kind: "client", clientId: UUID });
  });
});

describe("clientFilterSql", () => {
  it("yields TRUE (never an empty string) for 'all', so it is always safe to AND", () => {
    const f = clientFilterSql({ kind: "all" }, "p.client_id", 1);
    expect(f.sql).toBe("TRUE");
    expect(f.params).toEqual([]);
    // The property that matters: concatenation cannot produce `WHERE  AND x`.
    expect(`WHERE x IS NULL AND ${f.sql}`).toBe("WHERE x IS NULL AND TRUE");
  });

  it("tests for NULL on the internal scope and binds no parameter", () => {
    const f = clientFilterSql({ kind: "internal" }, "p.client_id", 3);
    expect(f.sql).toBe("p.client_id IS NULL");
    expect(f.params).toEqual([]);
  });

  it("compares as text at the given placeholder index", () => {
    const f = clientFilterSql({ kind: "client", clientId: "abc" }, "i.client_id", 4);
    // ::text, not a uuid cast on the parameter — a malformed id must MISS, not 500 from Postgres.
    expect(f.sql).toBe("i.client_id::text = $4");
    expect(f.params).toEqual(["abc"]);
  });

  it("does not interpolate the client id into the SQL string", () => {
    const evil = "'; DROP TABLE clients; --";
    const f = clientFilterSql({ kind: "client", clientId: evil }, "c.client_id", 1);
    expect(f.sql).not.toContain("DROP");
    expect(f.params).toEqual([evil]);
  });
});
