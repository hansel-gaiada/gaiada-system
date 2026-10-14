import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-6i UI: the Drive writes. The platform's refusals are put in words; the tenant is the active company; the return path is
// remembered only after the platform has handed back Google's https URL; the Picker credentials come back whole or as a sentence.

vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./drive-pending", () => ({ setDrivePending: vi.fn(async () => {}) }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1", assurance: "high", roles: [], companies: [] })) };
});

import { platformFetch, PlatformError } from "./platform";
import { setDrivePending } from "./drive-pending";
import { attachDriveFileAction, disconnectDriveAction, loadPickerCredentialsAction, startDriveConnectAction } from "./driveActions";

const fetchMock = vi.mocked(platformFetch);
const refused = (status: number, error: string, reason?: string) => new PlatformError(status, error, undefined, undefined, reason);
const picker = (over: Record<string, unknown> = {}) => ({
  configured: true, connected: true, needsReconnect: false, accountEmail: "a@b.test", accessToken: "ya29.tok", expiresAt: "x", apiKey: "k", appId: "p", ...over,
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(setDrivePending).mockClear();
});

describe("startDriveConnectAction", () => {
  it("GETs the start route for the active company, remembers the return path, and returns the auth URL", async () => {
    fetchMock.mockResolvedValue({ authUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
    const r = await startDriveConnectAction("/departments/d1/connections");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/integrations/google-drive/oauth/start");
    expect(setDrivePending).toHaveBeenCalledWith("/departments/d1/connections");
    expect(r).toEqual({ ok: true, authUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
  });

  it("refuses an auth URL that is not https, and remembers nothing", async () => {
    for (const authUrl of ["javascript:alert(1)", "http://accounts.google.com/x", "not a url", undefined]) {
      fetchMock.mockResolvedValue({ authUrl });
      const r = await startDriveConnectAction("/x");
      expect(r.ok, String(authUrl)).toBe(false);
    }
    expect(setDrivePending).not.toHaveBeenCalled();
  });

  it("says drive_not_configured in plain words and remembers nothing", async () => {
    fetchMock.mockRejectedValue(refused(503, "drive_not_configured: Google Drive is not set up", "drive_not_configured"));
    const r = await startDriveConnectAction("/x");
    expect(r).toEqual({ ok: false, error: "Google Drive isn't set up for this ERP yet." });
    expect(setDrivePending).not.toHaveBeenCalled();
  });
});

describe("disconnectDriveAction", () => {
  it("DELETEs the connection", async () => {
    fetchMock.mockResolvedValue({ disconnected: true, revokedAtGoogle: true });
    expect(await disconnectDriveAction()).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/integrations/google-drive");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("DELETE");
  });

  it("a 403 is a calm permission sentence", async () => {
    fetchMock.mockRejectedValue(refused(403, "forbidden"));
    const r = await disconnectDriveAction();
    expect(r.ok === false && r.error).toMatch(/don't have permission/);
  });
});

describe("loadPickerCredentialsAction", () => {
  it("returns the credentials of a connected answer", async () => {
    fetchMock.mockResolvedValue(picker());
    expect(await loadPickerCredentialsAction()).toEqual({ ok: true, credentials: { accessToken: "ya29.tok", apiKey: "k", appId: "p" } });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/integrations/google-drive/picker");
  });

  it("says each way it cannot, in words, with no token", async () => {
    fetchMock.mockResolvedValue(picker({ configured: false, connected: false, accessToken: null }));
    expect(await loadPickerCredentialsAction()).toEqual({ ok: false, error: "Google Drive isn't set up for this ERP yet." });
    fetchMock.mockResolvedValue(picker({ connected: false, needsReconnect: true, accessToken: null }));
    const r = await loadPickerCredentialsAction();
    expect(r.ok === false && r.error).toMatch(/Reconnect Google Drive/);
    fetchMock.mockResolvedValue(picker({ connected: false, accessToken: null }));
    expect(await loadPickerCredentialsAction()).toEqual({ ok: false, error: "Connect your Google Drive first." });
  });

  it("a connected answer missing its key is a broken read, not a half-built Picker", async () => {
    fetchMock.mockResolvedValue(picker({ apiKey: null }));
    const r = await loadPickerCredentialsAction();
    expect(r.ok).toBe(false);
  });
});

describe("attachDriveFileAction", () => {
  it("POSTs the task and file id for the active company", async () => {
    fetchMock.mockResolvedValue({ id: "file-1" });
    expect(await attachDriveFileAction("t1", "f1")).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/integrations/google-drive/attach");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0][2]?.body))).toEqual({ targetType: "task", targetId: "t1", fileId: "f1" });
  });

  it("puts each refusal in plain words", async () => {
    const cases: [number, string, string][] = [
      [409, "drive_already_attached: that Drive file is already attached", "That file is already attached to this task."],
      [404, "drive_file_not_found: x", "That file couldn't be found in your Google Drive, or it wasn't shared with this app when you picked it."],
      [409, "drive_needs_reconnect: x", "Google no longer accepts the saved Drive connection. Reconnect Google Drive to continue."],
      [502, "drive_unavailable: x", "Google Drive couldn't be reached. Try again in a moment."],
      [404, "target_not_found: x", "That task no longer exists. Reload the page."],
      [409, "drive_not_connected: x", "Connect your Google Drive first."],
    ];
    for (const [status, error, text] of cases) {
      fetchMock.mockRejectedValue(refused(status, error));
      expect(await attachDriveFileAction("t1", "f1"), error).toEqual({ ok: false, error: text });
    }
  });

  it("refuses an empty task or file id without calling the platform", async () => {
    expect((await attachDriveFileAction("", "f1")).ok).toBe(false);
    expect((await attachDriveFileAction("t1", "")).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
