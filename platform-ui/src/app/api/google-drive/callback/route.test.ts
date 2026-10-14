import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-6i UI: the Google Drive OAuth landing route. It forwards Google's code and state to the backend callback as the signed-in
// person, and redirects by outcome to the page the flow started from. The return target comes ONLY from the pending cookie and is
// re-validated; nothing in the query is ever a redirect target.

vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, platformFetch: vi.fn() };
});
vi.mock("@/lib/drive-pending", () => ({ consumeDrivePending: vi.fn() }));

import { getSessionUserId } from "@/lib/session-server";
import { platformFetch, PlatformError } from "@/lib/platform";
import { consumeDrivePending } from "@/lib/drive-pending";
import { GET } from "./route";

const ORIGIN = "https://erp.test";
const fetchMock = vi.mocked(platformFetch);
const call = (qs: string) => GET(new Request(`${ORIGIN}/api/google-drive/callback${qs}`));
const location = (res: Response) => new URL(res.headers.get("location") ?? "");

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(getSessionUserId).mockResolvedValue("u1");
  vi.mocked(consumeDrivePending).mockReset().mockResolvedValue({ returnPath: "/departments/d1/connections" });
});

describe("the Drive OAuth landing route", () => {
  it("forwards code and state to the backend callback as the signed-in person", async () => {
    fetchMock.mockResolvedValue({ status: "connected", accountEmail: "a@b.test" });
    await call("?code=4%2F0AbC&state=s.1~2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/google-drive/oauth/callback?code=4%2F0AbC&state=s.1~2");
    expect(fetchMock.mock.calls[0][1]).toBe("u1");
  });

  it("connected: redirects to the page it started from with driveOAuth=connected, and never carries the code, state or email", async () => {
    fetchMock.mockResolvedValue({ status: "connected", accountEmail: "a@b.test" });
    const res = await call("?code=CODE123&state=STATE456");
    const to = location(res);
    expect(res.status).toBe(307);
    expect(to.origin).toBe(ORIGIN);
    expect(to.pathname).toBe("/departments/d1/connections");
    expect(to.searchParams.get("driveOAuth")).toBe("connected");
    expect(to.search).not.toContain("CODE123");
    expect(to.search).not.toContain("STATE456");
    expect(to.search).not.toContain("a%40b.test");
  });

  it("denied (the backend says so): driveOAuth=denied", async () => {
    fetchMock.mockResolvedValue({ status: "denied", reason: "drive_consent_denied" });
    const to = location(await call("?code=c&state=s"));
    expect(to.searchParams.get("driveOAuth")).toBe("denied");
  });

  it("denied (Google sent error=access_denied): driveOAuth=denied, and the backend is not called", async () => {
    const to = location(await call("?error=access_denied&state=s"));
    expect(to.searchParams.get("driveOAuth")).toBe("denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a missing code or state is an error, with the known reason, and the backend is not called", async () => {
    for (const qs of ["", "?code=c", "?state=s"]) {
      const to = location(await call(qs));
      expect(to.searchParams.get("driveOAuth"), qs).toBe("error");
      expect(to.searchParams.get("driveOAuthReason"), qs).toBe("drive_state_invalid");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a backend refusal is an error carrying its known token as the reason", async () => {
    fetchMock.mockRejectedValue(new PlatformError(502, "drive_exchange_failed: Google refused the code", undefined, undefined, "drive_exchange_failed"));
    const to = location(await call("?code=c&state=s"));
    expect(to.searchParams.get("driveOAuth")).toBe("error");
    expect(to.searchParams.get("driveOAuthReason")).toBe("drive_exchange_failed");
    expect(to.search).not.toContain("refused");
  });

  it("a refusal with an unknown message carries no reason", async () => {
    fetchMock.mockRejectedValue(new PlatformError(500, "<script>alert(1)</script>"));
    const to = location(await call("?code=c&state=s"));
    expect(to.searchParams.get("driveOAuth")).toBe("error");
    expect(to.searchParams.has("driveOAuthReason")).toBe(false);
  });

  it("an unexpected answer shape is an error, not a connection", async () => {
    fetchMock.mockResolvedValue({ hello: "world" });
    const to = location(await call("?code=c&state=s"));
    expect(to.searchParams.get("driveOAuth")).toBe("error");
  });

  it("never takes a redirect target from the query", async () => {
    fetchMock.mockResolvedValue({ status: "connected", accountEmail: "a@b.test" });
    for (const qs of [
      "?code=c&state=s&returnPath=https://evil.example/x",
      "?code=c&state=s&return=//evil.example",
      "?code=c&state=s&redirect=https://evil.example&next=//evil.example&returnTo=/\\evil.example",
    ]) {
      const to = location(await call(qs));
      expect(to.origin, qs).toBe(ORIGIN);
      expect(to.pathname, qs).toBe("/departments/d1/connections");
    }
  });

  it("refuses an outside target even from the pending cookie, and lands on the root instead", async () => {
    fetchMock.mockResolvedValue({ status: "connected", accountEmail: "a@b.test" });
    for (const bad of ["//evil.example", "https://evil.example/x", "/\\evil.example"]) {
      vi.mocked(consumeDrivePending).mockResolvedValue({ returnPath: bad });
      const to = location(await call("?code=c&state=s"));
      expect(to.origin, bad).toBe(ORIGIN);
      expect(to.pathname, bad).toBe("/");
    }
  });

  it("with no pending cookie, still completes the connection and returns to the departments list", async () => {
    vi.mocked(consumeDrivePending).mockResolvedValue(null);
    fetchMock.mockResolvedValue({ status: "connected", accountEmail: "a@b.test" });
    const to = location(await call("?code=c&state=s"));
    expect(to.pathname).toBe("/departments");
    expect(to.searchParams.get("driveOAuth")).toBe("connected");
  });

  it("sends a signed-out visitor to /login without calling the backend", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null);
    const res = await call("?code=c&state=s");
    expect(location(res).pathname).toBe("/login");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
