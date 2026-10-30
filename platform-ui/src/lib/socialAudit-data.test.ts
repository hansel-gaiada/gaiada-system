import { describe, it, expect, vi, beforeEach } from "vitest";

// SCP-5g (BFF §63.28): the audit pages' two readers. Every answer is a `ReadResult`: a failed or malformed read is "cannot tell" and a 403 is "forbidden", never an empty list; an audit that does not exist
// is a real answer (`ok` with null), not a refusal.
vi.mock("./platform", async (orig) => ({ ...(await orig<typeof import("./platform")>()), platformFetch: vi.fn() }));

import { platformFetch, PlatformError } from "./platform";
import { getAudit, getAudits } from "./socialAudit-data";

beforeEach(() => { vi.mocked(platformFetch).mockReset(); });

const item = { auditId: "a1", subject: "client", engagementId: "e1", name: "Northwind Traders", status: "draft", overall: 62, band: "fair", bandLabel: "Fair", scored: 7, total: 12 };
const audit = { id: "a1", subject: "client", status: "draft", name: "Northwind Traders", dimensions: [], canWrite: true, canFinalize: true };

describe("getAudits", () => {
  it("asks the company's own audits route, with the subject only when it is one", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ items: [item], canAddProspect: true });
    const r = await getAudits("u-1", "co a");
    expect(platformFetch).toHaveBeenCalledWith("/api/co%20a/modules/social/audits", "u-1");
    expect(r).toMatchObject({ kind: "ok", data: { canAddProspect: true, items: [{ auditId: "a1", overall: 62 }] } });
    await getAudits("u-1", "co-a", "prospect");
    expect(platformFetch).toHaveBeenLastCalledWith("/api/co-a/modules/social/audits?subject=prospect", "u-1");
  });
  it("is forbidden on a 403 and cannot-tell on any other failure or a body that is not a list", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "not authorized"));
    expect((await getAudits("u-1", "co-a")).kind).toBe("forbidden");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "Not Found"));
    expect(await getAudits("u-1", "co-a")).toEqual({ kind: "unavailable", reason: "Not Found" });
    vi.mocked(platformFetch).mockResolvedValueOnce({ unexpected: true });
    expect((await getAudits("u-1", "co-a")).kind).toBe("unavailable");
  });
});

describe("getAudit", () => {
  it("reads one audit in the company, with the flags", async () => {
    vi.mocked(platformFetch).mockResolvedValue(audit);
    const r = await getAudit("u-1", "co-a", "a 1");
    expect(platformFetch).toHaveBeenCalledWith("/api/co-a/modules/social/audits/a%201", "u-1");
    expect(r).toMatchObject({ kind: "ok", data: { id: "a1", canWrite: true, canFinalize: true } });
  });
  it("an audit that does not exist is ok with null (a real answer), but any other 404 is cannot-tell", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "audit_not_found"));
    expect(await getAudit("u-1", "co-a", "gone")).toEqual({ kind: "ok", data: null });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "Not Found"));
    expect((await getAudit("u-1", "co-a", "x")).kind).toBe("unavailable");
  });
  it("is forbidden on a 403, and cannot-tell on a failure or a body that is not an audit", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "not authorized"));
    expect((await getAudit("u-1", "co-a", "a1")).kind).toBe("forbidden");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(502, "bad gateway"));
    expect(await getAudit("u-1", "co-a", "a1")).toEqual({ kind: "unavailable", reason: "bad gateway" });
    vi.mocked(platformFetch).mockResolvedValueOnce({ id: "a1" });
    expect((await getAudit("u-1", "co-a", "a1")).kind).toBe("unavailable");
  });
});
