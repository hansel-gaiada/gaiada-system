import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-7g-2 — the writes behind Finance > Chart of accounts. Cerbos (`finance_config`) decides who may add, rename, archive and
// restore; what is pinned here is the wire (route, method, body, revalidation), the words for a 403, the server's own 400 and 409
// text passed through WITH its reason, field and usedBy, and that a blank form never reaches the server.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1", assurance: "high", roles: [], companies: [] })) };
});

import { revalidatePath } from "next/cache";
import { platformFetch, PlatformError } from "./platform";
import { addAccount, archiveAccount, editAccount, restoreAccount } from "./financeAccountActions";

const fetchMock = vi.mocked(platformFetch);
const call = () => ({ path: fetchMock.mock.calls[0][0], init: fetchMock.mock.calls[0][2] });
const body = () => JSON.parse(String(call().init?.body));

beforeEach(() => { fetchMock.mockReset(); vi.mocked(revalidatePath).mockClear(); });

describe("addAccount", () => {
  it("POSTs the trimmed fields, uppercases the currency, and re-reads the chart", async () => {
    fetchMock.mockResolvedValue({ code: "4910" });
    const r = await addAccount({
      code: " 4910 ", name: " Interest income ", accountType: "revenue", normalBalance: "credit", parentCode: "4900",
      isPostable: true, currencyCode: "idr", description: " d ",
    });
    expect(r).toEqual({ ok: true, result: { code: "4910" } });
    expect(call().path).toBe("/api/co-1/finance/accounts");
    expect(call().init?.method).toBe("POST");
    expect(body()).toEqual({
      code: "4910", name: "Interest income", accountType: "revenue", normalBalance: "credit", parentCode: "4900",
      isPostable: true, currencyCode: "IDR", description: "d",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/finance/accounts");
  });

  it("sends only what was filled in: no parent, currency or description for a plain account", async () => {
    fetchMock.mockResolvedValue({ code: "T1" });
    await addAccount({ code: "T1", name: "Plain", accountType: "asset", parentCode: null, currencyCode: "", description: "" });
    expect(body()).toEqual({ code: "T1", name: "Plain", accountType: "asset" });
  });

  it("says a 403 in words and does not revalidate", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "forbidden"));
    const r = await addAccount({ code: "T1", name: "x", accountType: "asset" });
    expect(r).toEqual({ ok: false, error: "You don't have permission to add accounts." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("passes a 409 and a 400 through with their reason and field", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "account code 4910 is already used by a live account in this company", undefined, undefined, "code_taken"));
    expect(await addAccount({ code: "4910", name: "x", accountType: "revenue" })).toEqual({
      ok: false, error: "account code 4910 is already used by a live account in this company", reason: "code_taken",
    });
    fetchMock.mockRejectedValueOnce(new PlatformError(400, "parentCode 4900 is a revenue account; the parent of a expense account must also be expense", "parentCode"));
    expect(await addAccount({ code: "4920", name: "x", accountType: "expense", parentCode: "4900" })).toEqual({
      ok: false, error: "parentCode 4900 is a revenue account; the parent of a expense account must also be expense", field: "parentCode",
    });
  });

  it("refuses a blank or malformed form before any request", async () => {
    expect((await addAccount({ code: "", name: "x", accountType: "asset" })).field).toBe("code");
    expect((await addAccount({ code: "has space", name: "x", accountType: "asset" })).field).toBe("code");
    expect((await addAccount({ code: "T1", name: "  ", accountType: "asset" })).field).toBe("name");
    expect((await addAccount({ code: "T1", name: "n".repeat(121), accountType: "asset" })).field).toBe("name");
    expect((await addAccount({ code: "T1", name: "x", accountType: "income" as never })).field).toBe("accountType");
    expect((await addAccount({ code: "T1", name: "x", accountType: "asset", currencyCode: "RUPIAH" })).field).toBe("currencyCode");
    expect((await addAccount({ code: "T1", name: "x", accountType: "asset", description: "d".repeat(501) })).field).toBe("description");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("editAccount", () => {
  it("PATCHes only the fields sent, to the encoded code, and clears a description with null", async () => {
    fetchMock.mockResolvedValue({ code: "T101" });
    await editAccount("T 100/x", { name: " New ", description: "  ", newCode: "T101" });
    expect(call().path).toBe("/api/co-1/finance/accounts/T%20100%2Fx");
    expect(call().init?.method).toBe("PATCH");
    expect(body()).toEqual({ name: "New", description: null, newCode: "T101" });
    expect(revalidatePath).toHaveBeenCalledWith("/finance/accounts");
  });

  it("passes the frozen-code 409 through with its reason and the database's hint", async () => {
    fetchMock.mockRejectedValue(new PlatformError(
      409, "account T101 has postings; code cannot change. Archive this account and create a new one; re-coding rewrites history.",
      undefined, undefined, "account_frozen",
      { error: "x", reason: "account_frozen", hint: "Archive this account and create a new one; re-coding rewrites history." },
    ));
    const r = await editAccount("T101", { newCode: "T102" });
    expect(r).toMatchObject({ ok: false, reason: "account_frozen", hint: "Archive this account and create a new one; re-coding rewrites history." });
    expect(r.error).toMatch(/has postings/);
  });

  it("says a 403 in words; refuses an empty edit, a blank name and a bad code before any request", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await editAccount("T1", { name: "x" })).error).toBe("You don't have permission to edit accounts.");
    fetchMock.mockClear();
    expect((await editAccount("T1", {})).error).toBe("Nothing to change.");
    expect((await editAccount("T1", { name: " " })).field).toBe("name");
    expect((await editAccount("T1", { newCode: "no good" })).field).toBe("newCode");
    expect((await editAccount("", { name: "x" })).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("archiveAccount and restoreAccount", () => {
  it("POST to the account's archive and restore routes, with no body", async () => {
    fetchMock.mockResolvedValue({ code: "U100", status: "archived" });
    expect(await archiveAccount("U100")).toEqual({ ok: true, result: { code: "U100", status: "archived" } });
    expect(call().path).toBe("/api/co-1/finance/accounts/U100/archive");
    expect(call().init?.method).toBe("POST");
    expect(call().init?.body).toBeUndefined();
    fetchMock.mockReset().mockResolvedValue({ code: "U100", status: "active" });
    await restoreAccount("U100");
    expect(call().path).toBe("/api/co-1/finance/accounts/U100/restore");
    expect(revalidatePath).toHaveBeenCalledWith("/finance/accounts");
  });

  it("passes each archive refusal through with its reason; account_in_use carries usedBy", async () => {
    for (const reason of ["account_has_balance", "account_has_children", "account_is_control"]) {
      fetchMock.mockRejectedValueOnce(new PlatformError(409, `1120 (Bank): ${reason}`, undefined, undefined, reason, { error: "x", reason }));
      expect(await archiveAccount("1120")).toEqual({ ok: false, error: `1120 (Bank): ${reason}`, reason });
    }
    const usedBy = [{ table: "finance_posting_rules", count: 2 }, { table: "finance_tax_codes", count: 1 }];
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "R100 is still used", undefined, undefined, "account_in_use", { error: "R100 is still used", reason: "account_in_use", usedBy }));
    expect(await archiveAccount("R100")).toEqual({ ok: false, error: "R100 is still used", reason: "account_in_use", usedBy });
  });

  it("ignores a usedBy that is not the right shape", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "m", undefined, undefined, "account_in_use", { usedBy: [{ table: 3 }, "x"] }));
    expect(await archiveAccount("R100")).toEqual({ ok: false, error: "m", reason: "account_in_use" });
  });

  it("passes parent_archived through; says a 403 in words; needs a code", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "PC sits under PH, which is archived", undefined, undefined, "parent_archived"));
    expect(await restoreAccount("PC")).toEqual({ ok: false, error: "PC sits under PH, which is archived", reason: "parent_archived" });
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await archiveAccount("PC")).error).toBe("You don't have permission to archive accounts.");
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await restoreAccount("PC")).error).toBe("You don't have permission to restore accounts.");
    fetchMock.mockClear();
    expect((await archiveAccount("")).ok).toBe(false);
    expect((await restoreAccount("")).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rethrows what is not a platform answer (a socket failure is not a refusal)", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    await expect(archiveAccount("U100")).rejects.toThrow("socket hang up");
  });
});
