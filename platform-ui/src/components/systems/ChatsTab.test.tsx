import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ChatsTab } from "./ChatsTab";

const CHAT_A = {
  chatId: "1111@g.us",
  kind: "group" as const,
  surface: "whatsapp" as const,
  name: "Ops Group",
  messageCount: 5,
  lastActivityTs: Date.now() - 60_000,
  lastPreview: "see you tomorrow",
};
const CHAT_B = {
  chatId: "tg:22222",
  kind: "dm" as const,
  surface: "telegram" as const,
  name: "Alice",
  messageCount: 2,
  lastActivityTs: Date.now() - 120_000,
  lastPreview: "thanks!",
};

function chatsRes(chats: unknown[]) {
  return { ok: true, json: () => Promise.resolve({ chats }) } as Response;
}
function messagesRes(messages: unknown[]) {
  return { ok: true, json: () => Promise.resolve({ messages }) } as Response;
}

// Router: URL contains "/messages" -> thread fetch, else chat-list fetch.
function router(chats: unknown[], messagesByChatId: Record<string, unknown[]>) {
  return vi.fn(async (url: string) => {
    const s = String(url);
    if (s.includes("/messages")) {
      const encoded = s.split("/api/admin/bot/chats/")[1].split("/messages")[0];
      const chatId = decodeURIComponent(encoded);
      return messagesRes(messagesByChatId[chatId] ?? []);
    }
    return chatsRes(chats);
  });
}

describe("ChatsTab", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not fetch at all when the caller isn't elevated (cosmetic gate)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatsTab elevated={false} />);
    expect(screen.getByText(/limited to superadmins\/owners/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads the chat list, auto-selects the first (newest) chat, and fetches its thread", async () => {
    const fetchMock = router([CHAT_A, CHAT_B], {
      [CHAT_A.chatId]: [
        { ts: 1, senderId: "u1", senderName: "Bob", text: "hello there", fromBot: false },
        { ts: 2, senderId: "bot", senderName: "Bot", text: "hi Bob", fromBot: true },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<ChatsTab elevated />);
    });

    expect(screen.getByText("Ops Group")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    // Auto-selected chat's thread loaded without a click.
    expect(screen.getByText("hello there")).toBeInTheDocument();
    expect(screen.getByText("hi Bob")).toBeInTheDocument();
    // The messages fetch used the URL-encoded chatId ("@" -> %40).
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/bot/chats/1111%40g.us/messages"),
      expect.anything(),
    );
  });

  it("clicking a different chat row fetches and swaps in that chat's thread", async () => {
    const fetchMock = router([CHAT_A, CHAT_B], {
      [CHAT_A.chatId]: [{ ts: 1, senderId: "u1", senderName: "Bob", text: "from ops", fromBot: false }],
      [CHAT_B.chatId]: [{ ts: 1, senderId: "u2", senderName: "Alice", text: "from alice", fromBot: false }],
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<ChatsTab elevated />);
    });
    expect(screen.getByText("from ops")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText("Alice"));
    });
    expect(screen.getByText("from alice")).toBeInTheDocument();
    expect(screen.queryByText("from ops")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/bot/chats/tg%3A22222/messages"),
      expect.anything(),
    );
  });

  it("renders message text and previews as inert text only — never as HTML", async () => {
    const payload = "<img src=x onerror=alert(1)>";
    const fetchMock = router(
      [{ ...CHAT_A, lastPreview: payload }],
      { [CHAT_A.chatId]: [{ ts: 1, senderId: "u1", senderName: "Bob", text: payload, fromBot: false }] },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<ChatsTab elevated />);
    await act(async () => {});

    // The literal string is present as text...
    expect(screen.getAllByText(payload).length).toBeGreaterThan(0);
    // ...and no <img> element was ever created from it.
    expect(container.querySelector("img")).toBeNull();
  });

  it("polls the chat list every ~15s and the selected thread every ~6s, and stops on unmount", async () => {
    const fetchMock = router([CHAT_A], { [CHAT_A.chatId]: [] });
    vi.stubGlobal("fetch", fetchMock);

    let unmount: () => void;
    await act(async () => {
      const r = render(<ChatsTab elevated />);
      unmount = r.unmount;
    });

    // Initial: 1 chat-list fetch + 1 messages fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    // One more messages poll (6s elapsed, chat list not yet due at 15s).
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000); // total 15s
    });
    // Chat list poll fires (+1) and another messages poll at 12s already
    // counted; by 15s a second messages tick (12s) has also fired.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);

    const callsAtUnmount = fetchMock.mock.calls.length;
    await act(async () => {
      unmount();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // No further calls after unmount — polling has fully stopped.
    expect(fetchMock.mock.calls.length).toBe(callsAtUnmount);
  });
});
