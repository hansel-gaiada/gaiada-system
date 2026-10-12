import { describe, it, expect, vi, beforeEach } from "vitest";

// PV5-06 — the client's sign action. The client signs WHAT THEY SAW: the page carries the agreement's SHA-256 (the
// portal GET's `contentSha256`) in a hidden field, and this action must send it to `POST .../sign` so the server can
// compare it with the hash it fixed at send. On a 409 the action reloads the page and says so, and never reports success.

vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: vi.fn() })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-1", name: "Example" })) }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1" })) };
});

import { revalidatePath } from "next/cache";
import { platformFetch, PlatformError } from "./platform";
import { portalSignContract } from "./portalActions";

const fetchMock = vi.mocked(platformFetch);
const HASH = "a".repeat(64);

function form(over: Record<string, string | null> = {}): FormData {
  const f = new FormData();
  const fields: Record<string, string | null> = {
    contractId: "k-1", signerName: "Dana Whitfield", signerTitle: "", agree: "yes", contentSha256: HASH, ...over,
  };
  for (const [k, v] of Object.entries(fields)) if (v !== null) f.set(k, v);
  return f;
}
const bodyOfLastCall = () => JSON.parse(String(fetchMock.mock.calls[0][2]?.body));

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(revalidatePath).mockClear();
});

describe("portalSignContract sends the hash the page showed", () => {
  it("POSTs contentSha256 with the signature to the company's sign route", async () => {
    fetchMock.mockResolvedValue({ complete: false, alreadySigned: false });
    const r = await portalSignContract(null, form());
    expect(r).toEqual({ ok: true, id: "k-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/portal/contracts/k-1/sign");
    expect(bodyOfLastCall()).toMatchObject({ signerName: "Dana Whitfield", agree: true, contentSha256: HASH });
  });

  it("a contract sent before PV5-06 has no hash on the page: the field is simply omitted", async () => {
    fetchMock.mockResolvedValue({ complete: false, alreadySigned: false });
    await portalSignContract(null, form({ contentSha256: null }));
    expect(bodyOfLastCall()).not.toHaveProperty("contentSha256");
  });

  it("a 409 (the agreement changed) reloads the page, says so, and is NOT a success", async () => {
    fetchMock.mockRejectedValue(new PlatformError(409, "this agreement changed since you opened it; reload it and read it again before signing", undefined, undefined, "content_changed"));
    const r = await portalSignContract(null, form());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/changed since you opened it/i);
    expect(r.error).toMatch(/reloaded/i);
    expect(revalidatePath).toHaveBeenCalledWith("/portal/contracts/k-1");
  });

  it("a page opened before this shipped (400 content_hash_required) reloads the same way", async () => {
    fetchMock.mockRejectedValue(new PlatformError(400, "contentSha256 is required: reload the agreement and sign again", undefined, undefined, "content_hash_required"));
    const r = await portalSignContract(null, form({ contentSha256: null }));
    expect(r).toMatchObject({ ok: false });
    expect(revalidatePath).toHaveBeenCalledWith("/portal/contracts/k-1");
  });

  it("any other refusal is surfaced verbatim and does not reload", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "Your access to this portal is view-only."));
    const r = await portalSignContract(null, form());
    expect(r).toMatchObject({ ok: false, error: "Your access to this portal is view-only." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses before any network call without the attestation", async () => {
    const r = await portalSignContract(null, form({ agree: null }));
    expect(r).toMatchObject({ ok: false, field: "agree" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
