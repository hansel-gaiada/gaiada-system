// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
const platformFetch = vi.fn();
vi.mock("./platform", () => {
  class PlatformError extends Error { constructor(public status: number, message: string) { super(message); } }
  return { getMe: vi.fn(async () => ({})), PlatformError, platformFetch: (...a: unknown[]) => platformFetch(...a) };
});

import { revalidatePath } from "next/cache";
import { PlatformError } from "./platform";
import { attachFileAction, deleteFileAction, uploadFileAction } from "./collabActions";

// DW-8h (contract 45.2): the upload action.
const form = (f: File | null) => { const fd = new FormData(); if (f) fd.set("file", f); return fd; };

beforeEach(() => { platformFetch.mockReset(); vi.mocked(revalidatePath).mockClear(); });

describe("uploadFileAction", () => {
  it("refuses a file over 25 MB before sending", async () => {
    const big = new File(["x"], "big.bin");
    Object.defineProperty(big, "size", { value: 25 * 1024 * 1024 + 1 });
    const r = await uploadFileAction("work_request", "r1", "/requests/r1", form(big));
    expect(r).toEqual({ ok: false, error: "Files can be at most 25 MB." });
    expect(platformFetch).not.toHaveBeenCalled();
  });
  it("posts base64 content and revalidates the given path", async () => {
    platformFetch.mockResolvedValue({ id: "n1", scrubbed: true, byteSize: 5 });
    const r = await uploadFileAction("agency_campaign_part", "p1", "/agency/c1", form(new File(["hello"], "a.txt", { type: "text/plain" })));
    expect(r).toEqual({ ok: true, id: "n1", scrubbed: true });
    const [path, , init] = platformFetch.mock.calls[0];
    expect(path).toBe("/api/co-1/files");
    expect(JSON.parse(init.body)).toEqual({ targetType: "agency_campaign_part", targetId: "p1", filename: "a.txt", contentType: "text/plain", content: "aGVsbG8=" });
    expect(revalidatePath).toHaveBeenCalledWith("/agency/c1");
  });
  it("words 403 on a request, 403 elsewhere, 404 and 409", async () => {
    const fd = () => form(new File(["x"], "a.txt"));
    platformFetch.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await uploadFileAction("work_request", "r1", "/r", fd())).error).toBe("Only the people on this request can add files.");
    platformFetch.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await uploadFileAction("client", "c1", "/r", fd())).error).toBe("You can't add files here.");
    platformFetch.mockRejectedValueOnce(new PlatformError(404, "target_not_found"));
    expect((await uploadFileAction("work_request", "r1", "/r", fd())).error).toBe("This item no longer exists.");
    platformFetch.mockRejectedValueOnce(new PlatformError(409, "target_closed"));
    expect((await uploadFileAction("work_request", "r1", "/r", fd())).error).toBe("This item is closed, so it takes no new files.");
  });
  it("asks for a file when there is none", async () => {
    expect((await uploadFileAction("client", "c1", "/r", form(null))).error).toBe("Choose a file to upload.");
  });
});

describe("attach and remove: the revalidated path", () => {
  it("default to the old guess for the task page and take an explicit path for the new pages", async () => {
    platformFetch.mockResolvedValue({ id: "a1", ok: true });
    const fd = new FormData(); fd.set("filename", "Link");
    await attachFileAction("task", "t1", fd);
    expect(revalidatePath).toHaveBeenLastCalledWith("/tasks/t1");
    await attachFileAction("work_request", "r1", fd, "/requests/r1");
    expect(revalidatePath).toHaveBeenLastCalledWith("/requests/r1");
    await deleteFileAction("work_request", "r1", "f1", "/requests/r1");
    expect(revalidatePath).toHaveBeenLastCalledWith("/requests/r1");
    await deleteFileAction("task", "t1", "f1");
    expect(revalidatePath).toHaveBeenLastCalledWith("/tasks/t1");
  });
});
