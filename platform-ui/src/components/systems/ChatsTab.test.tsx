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

  it("a failed thread fetch surfaces an error instead of sitting on 'Loading messages…'", async () => {
    // The bot answers 404 for a chat with no stored transcript; the pane must not claim to be
    // loading forever (it did before — `messages` stays null on the error path).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/messages")
          ? ({ ok: false, json: () => Promise.resolve({ error: "unknown chat (no stored messages)" }) } as Response)
          : chatsRes([CHAT_A]),
      ),
    );
    render(<ChatsTab elevated />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText(/unknown chat \(no stored messages\)/)).toBeInTheDocument();
    expect(screen.getByText(/couldn't be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/Loading messages/i)).not.toBeInTheDocument();
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

  it("debounces the chat-search box before filtering the list via ?q= (no request per keystroke)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const s = String(url);
      if (s.includes("/messages")) return messagesRes([]);
      return chatsRes(s.includes("q=ops") ? [CHAT_A] : [CHAT_A, CHAT_B]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<ChatsTab elevated />);
    });
    const callsBeforeTyping = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats" }), { target: { value: "ops" } });

    // Still inside the debounce window — no extra request fired yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(fetchMock.mock.calls.length).toBe(callsBeforeTyping);

    // Past the debounce window — exactly one filtered request goes out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("q=ops"), expect.anything());
  });

  it("refetches the chat list with ?kind= as soon as the kind filter changes (not debounced)", async () => {
    const fetchMock = router([CHAT_A, CHAT_B], { [CHAT_A.chatId]: [] });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<ChatsTab elevated />);
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Filter chats by kind" }), { target: { value: "group" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("kind=group"), expect.anything());
  });

  it("searches messages across all chats (distinct from the chat-list search) and opens the picked result's thread", async () => {
    const searchResults = [
      {
        chatId: CHAT_B.chatId,
        chatName: CHAT_B.name,
        kind: "dm",
        surface: "telegram",
        ts: 555,
        senderName: "Alice",
        text: "matching text here",
      },
    ];
    const fetchMock = vi.fn(async (url: string) => {
      const s = String(url);
      if (s.includes("/api/admin/bot/search")) {
        return { ok: true, json: () => Promise.resolve({ results: searchResults }) } as Response;
      }
      if (s.includes(`/api/admin/bot/chats/${encodeURIComponent(CHAT_B.chatId)}/messages`)) {
        return messagesRes([{ ts: 1, senderId: "u2", senderName: "Alice", text: "from alice", fromBot: false }]);
      }
      if (s.includes("/messages")) return messagesRes([]);
      return chatsRes([CHAT_A, CHAT_B]);
    });
    vi.stubGlobal("fetch", fetchMock);

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ChatsTab elevated />));
    });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search messages" }), { target: { value: "matching" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/bot/search?q=matching"),
      expect.anything(),
    );
    expect(screen.getByText("matching text here")).toBeInTheDocument();
    // The result's own chat-name element is unambiguous (unlike "Alice", which also names the
    // chat-list row and the sender-name/time meta line).
    expect(container.querySelector(".bot-search-result__chat")?.textContent).toBe(CHAT_B.name);

    await act(async () => {
      fireEvent.click(screen.getByText("matching text here"));
    });

    // Clicking the result opened THAT chat's thread.
    expect(screen.getByText("from alice")).toBeInTheDocument();
  });

  it("loads older messages via ?beforeTs= and prepends them, hiding the control once hasMore is false", async () => {
    const initialMsgs = [{ ts: 200, senderId: "u1", senderName: "Bob", text: "newer msg", fromBot: false }];
    const olderMsgs = [{ ts: 50, senderId: "u1", senderName: "Bob", text: "older msg", fromBot: false }];
    const fetchMock = vi.fn(async (url: string) => {
      const s = String(url);
      if (s.includes("beforeTs=200")) {
        return { ok: true, json: () => Promise.resolve({ messages: olderMsgs, hasMore: false }) } as Response;
      }
      if (s.includes("/messages")) {
        return { ok: true, json: () => Promise.resolve({ messages: initialMsgs, hasMore: true }) } as Response;
      }
      return chatsRes([CHAT_A]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<ChatsTab elevated />);
    });

    expect(screen.getByText("newer msg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load older" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("beforeTs=200"), expect.anything());
    // Prepended, not replaced — the newer message the operator was already looking at is intact.
    expect(screen.getByText("older msg")).toBeInTheDocument();
    expect(screen.getByText("newer msg")).toBeInTheDocument();
    // hasMore:false on the paged response hides the control.
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
  });

  it("a 6s poll merges in new messages without dropping ones loaded via Load older", async () => {
    const jsonRes = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) } as Response);
    let messagesCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      const s = String(url);
      if (s.includes("beforeTs=200")) {
        return jsonRes({
          messages: [{ ts: 50, senderId: "u1", senderName: "Bob", text: "older msg", fromBot: false }],
          hasMore: false,
        });
      }
      if (s.includes("/messages")) {
        messagesCalls += 1;
        // First read: just the "newer msg" window. Every poll after that: the bot's "latest N"
        // now also covers a brand-new message — but NEVER the older one paged in separately,
        // exactly like a real store that only ever returns its most-recent window.
        const latest =
          messagesCalls === 1
            ? [{ ts: 200, senderId: "u1", senderName: "Bob", text: "newer msg", fromBot: false }]
            : [
                { ts: 200, senderId: "u1", senderName: "Bob", text: "newer msg", fromBot: false },
                { ts: 300, senderId: "u1", senderName: "Bob", text: "brand new msg", fromBot: false },
              ];
        return jsonRes({ messages: latest, hasMore: true });
      }
      return chatsRes([CHAT_A]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<ChatsTab elevated />);
    });
    expect(screen.getByText("newer msg")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    });
    expect(screen.getByText("older msg")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    // The poll's new message merged in AND the older, paged-in message survived the poll
    // (a naive replace would have dropped it back to just the latest window).
    expect(screen.getByText("older msg")).toBeInTheDocument();
    expect(screen.getByText("brand new msg")).toBeInTheDocument();
  });

  it("paginates a 45-chat list at 30 per page without resetting the page on the next 15s poll", async () => {
    const manyChats = Array.from({ length: 45 }, (_, i) => ({
      chatId: `chat-${i + 1}`,
      kind: "group" as const,
      surface: "whatsapp" as const,
      name: `Chat ${i + 1}`,
      messageCount: 1,
      lastActivityTs: Date.now() - i * 1000,
      lastPreview: "preview",
    }));
    const fetchMock = router(manyChats, { "chat-1": [] });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<ChatsTab elevated />);
    });

    expect(screen.getByText("Chat 1")).toBeInTheDocument();
    expect(screen.queryByText("Chat 31")).not.toBeInTheDocument();
    expect(screen.getByText("1–30 of 45")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    });
    expect(screen.getByText("Chat 31")).toBeInTheDocument();
    expect(screen.queryByText("Chat 1")).not.toBeInTheDocument();

    // A 15s poll refetches the same (unfiltered) list — the operator's page-2 view must survive it,
    // not snap back to page 1 under them.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByText("Chat 31")).toBeInTheDocument();
    expect(screen.queryByText("Chat 1")).not.toBeInTheDocument();
  });
});
