import { describe, it, expect, vi, beforeEach } from "vitest";

// AIP-10 - the send call's body. A plain send is byte-identical to before; `context` is added only when the origin has a department.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./assistant-data", () => ({ THREAD_LIST_LIMIT: 50 }));
vi.mock("./admin", () => ({}));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1", assurance: "high", roles: [], companies: [] })) };
});

import { platformFetch } from "./platform";
import { sendMessageAction } from "./assistantActions";

const fetchMock = vi.mocked(platformFetch);
const sentBody = (): unknown => JSON.parse(String((fetchMock.mock.calls[0][2] as { body: string }).body));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ messageId: "m1", streamUrl: "/s" });
});

describe("sendMessageAction body", () => {
  it("a plain send is exactly { content }", async () => {
    await sendMessageAction("t1", "hi", { mode: "chat" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/assistant/threads/t1/messages");
    expect(fetchMock.mock.calls[0][2]).toEqual({ method: "POST", body: '{"content":"hi"}' });
    fetchMock.mockClear();
    await sendMessageAction("t1", "hi");
    expect(sentBody()).toEqual({ content: "hi" });
  });

  it("with a department the body carries context { departmentId, page }", async () => {
    await sendMessageAction("t1", "hi", { mode: "chat", context: { departmentId: "d-seo", page: "Rankings" } });
    expect(sentBody()).toEqual({ content: "hi", context: { departmentId: "d-seo", page: "Rankings" } });
  });

  it("without a page the context is the department alone; a null context or an empty id adds nothing", async () => {
    await sendMessageAction("t1", "hi", { context: { departmentId: "d-seo", page: null } });
    expect(sentBody()).toEqual({ content: "hi", context: { departmentId: "d-seo" } });
    fetchMock.mockClear();
    await sendMessageAction("t1", "hi", { context: null });
    expect(sentBody()).toEqual({ content: "hi" });
    fetchMock.mockClear();
    await sendMessageAction("t1", "hi", { context: { departmentId: "", page: "Board" } });
    expect(sentBody()).toEqual({ content: "hi" });
  });

  it("context rides beside a tools-mode turn", async () => {
    await sendMessageAction("t1", "hi", { mode: "tools", agent: "status-reporter", context: { departmentId: "d-seo" } });
    expect(sentBody()).toEqual({ content: "hi", mode: "tools", agent: "status-reporter", context: { departmentId: "d-seo" } });
  });
});
