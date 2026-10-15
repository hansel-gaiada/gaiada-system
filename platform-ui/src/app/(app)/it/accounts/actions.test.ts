import { describe, it, expect, vi, beforeEach } from "vitest";
import { itAdmin } from "@/lib/itSecurityFixtures";

// DW-7h (BFF §52.7, §52.8): the two account actions the security work changed. Disable now answers whether the person's open
// sessions were ended (`sessionsEnded`), and the page must be able to say so; a reset password is the same call as before (the
// password is now TEMPORARY, said on the panel, not here).
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => itAdmin) };
});

import { platformFetch } from "@/lib/platform";
import { disableAccount, resetAccountPassword } from "./actions";

const fetchMock = vi.mocked(platformFetch);
const form = (over: Record<string, string> = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ userId: "u-2", email: "dewi@x.test", ...over })) fd.set(k, v);
  return fd;
};

beforeEach(() => fetchMock.mockReset());

describe("disableAccount", () => {
  it("says the person's sessions were ended, and carries the flag", async () => {
    fetchMock.mockResolvedValue({ ok: true, alreadyDisabled: false, sessionsEnded: true });
    const r = await disableAccount(form());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/it/accounts/u-2/disable");
    expect(r).toMatchObject({ ok: true, sessionsEnded: true });
    expect(r.ok && r.message).toMatch(/every session they had open was ended/);
  });

  it("★ says when the sessions were NOT confirmed ended, and where to finish the job", async () => {
    fetchMock.mockResolvedValue({ ok: true, alreadyDisabled: false, sessionsEnded: false });
    const r = await disableAccount(form());
    expect(r).toMatchObject({ ok: true, sessionsEnded: false });
    expect(r.ok && r.message).toMatch(/did not confirm ending their open sessions/);
    expect(r.ok && r.message).toMatch(/Network > Connected/);
  });

  it("keeps the old wording when the server says nothing about sessions, and when it was already disabled", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, alreadyDisabled: false });
    expect(await disableAccount(form())).toEqual({ ok: true, message: "dewi@x.test disabled." });
    fetchMock.mockResolvedValueOnce({ ok: true, alreadyDisabled: true, sessionsEnded: true });
    expect(await disableAccount(form())).toEqual({ ok: true, message: "dewi@x.test was already disabled — nothing changed." });
  });
});

describe("resetAccountPassword", () => {
  it("returns the temporary password once, for the panel, and requires a reason", async () => {
    fetchMock.mockResolvedValue({ ok: true, initialPassword: "Temp-1234" });
    const r = await resetAccountPassword(form({ reason: "locked out" }));
    expect(r).toEqual({ ok: true, message: "Password reset for dewi@x.test.", password: "Temp-1234", email: "dewi@x.test" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][2]?.body))).toEqual({ reason: "locked out" });
    fetchMock.mockClear();
    expect(await resetAccountPassword(form())).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
