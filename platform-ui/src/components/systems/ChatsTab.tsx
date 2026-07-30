"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Card, Button, Toast, Eyebrow } from "@/components/ui";
import { EmptyNote } from "./EmptyNote";
import { Paginator, usePagination } from "./Paginator";
import { formatRelativeTime } from "@/lib/timeFormat";
import "./systems.css";
import "./bot-extras.css";
import "@/components/forms/forms.css";

// Read-only WhatsApp/Telegram-style two-pane chat viewer (frozen nest contract
// `/api/admin/bot/chats` + `/api/admin/bot/chats/:chatId/messages`, plus the
// new `/api/admin/bot/search` cross-chat message search), reached through this
// app's own no-store proxy routes (never the platform directly — tokens never
// reach the browser, same as WhatsAppConnect's session poll).
//
// CRITICAL: every piece of chat content here (name, lastPreview, senderName,
// text, mediaText, message-search text) is UNTRUSTED — it is rendered
// EXCLUSIVELY as a plain React text child below. There is no
// dangerouslySetInnerHTML, no markdown-to-HTML conversion, anywhere in this file.
//
// Polling: the chat list polls every ~15s and the selected thread every ~6s,
// both only while this component is mounted (i.e. the Chats tab is active —
// BotTabs unmounts inactive tabs, which is what actually stops the interval;
// there is no separate "is tab active" flag to get out of sync).
const CHATS_POLL_MS = 15_000;
const MESSAGES_POLL_MS = 6_000;
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_RESULT_LIMIT = 25;

export interface BotChatSummary {
  chatId: string;
  kind: "group" | "dm";
  surface: "whatsapp" | "telegram";
  name: string;
  messageCount: number;
  lastActivityTs: number;
  lastPreview: string;
}

export interface BotChatMessage {
  ts: number;
  senderId: string;
  senderName: string;
  text: string;
  fromBot: boolean;
  mediaMime?: string;
  mediaStatus?: string;
  mediaText?: string;
}

// One hit from the cross-chat message search (`GET /admin/search`) — distinct from
// BotChatSummary/BotChatMessage because it carries which chat it came from, so a result can be
// opened directly into that chat's thread.
export interface BotSearchResult {
  chatId: string;
  chatName: string;
  kind: "group" | "dm";
  surface: "whatsapp" | "telegram";
  ts: number;
  senderName: string;
  text: string;
}

// Merge a poll's "latest N messages" response into what's already loaded, WITHOUT discarding
// older messages the operator paged in via "Load older" — a plain replace would silently drop
// them again every ~6s. Dedup key is ts+sender+fromBot: good enough for this store (no message
// ids on the wire) since two genuinely distinct messages from the same sender at the exact same
// millisecond are not a real-world case here.
function mergeLatest(latest: BotChatMessage[], prev: BotChatMessage[]): BotChatMessage[] {
  if (prev.length === 0) return latest;
  const key = (m: BotChatMessage) => `${m.ts}:${m.senderId}:${m.fromBot}`;
  const seen = new Set(prev.map(key));
  const appended = latest.filter((m) => !seen.has(key(m)));
  return appended.length === 0 ? prev : [...prev, ...appended];
}

export function ChatsTab({ elevated }: { elevated: boolean }) {
  const [chats, setChats] = useState<BotChatSummary[] | null>(null);
  const [chatsError, setChatsError] = useState<string | undefined>();
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BotChatMessage[] | null>(null);
  const [messagesError, setMessagesError] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Chat-list search/filter. The input is debounced so typing doesn't fire a request per
  // keystroke; `chatQuery`/`kindFilter` are the values actually sent to the server.
  const [chatQueryInput, setChatQueryInput] = useState("");
  const [chatQuery, setChatQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"" | "group" | "dm">("");

  // Cross-chat MESSAGE search — a separate concern from the chat-list filter above: it hits
  // every stored chat's content, not just names, and its results are a distinct list the
  // operator opens into a thread rather than a filtered version of the left pane.
  const [msgQueryInput, setMsgQueryInput] = useState("");
  const [msgQuery, setMsgQuery] = useState("");
  const [searchResults, setSearchResults] = useState<BotSearchResult[] | null>(null);
  const [searchError, setSearchError] = useState<string | undefined>();
  const [searchPending, setSearchPending] = useState(false);

  // Scroll-position preservation for "Load older": captured just before the prepend, restored
  // in a layout effect once the DOM has grown (so the same message stays under the viewport).
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollAdjustRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);

  const fetchChats = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (chatQuery) qs.set("q", chatQuery);
      if (kindFilter) qs.set("kind", kindFilter);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const res = await fetch(`/api/admin/bot/chats${suffix}`, { cache: "no-store" });
      const body = (await res.json()) as { chats: BotChatSummary[] | null; error?: string };
      if (!res.ok || body.chats == null) {
        setChatsError(body.error ?? "Could not load chats.");
        return;
      }
      setChats(body.chats);
      setChatsError(undefined);
    } catch {
      setChatsError("Could not reach the bot admin proxy.");
    }
  }, [chatQuery, kindFilter]);

  const fetchMessages = useCallback(async (chatId: string) => {
    try {
      const res = await fetch(`/api/admin/bot/chats/${encodeURIComponent(chatId)}/messages`, { cache: "no-store" });
      const body = (await res.json()) as { messages: BotChatMessage[] | null; hasMore?: boolean; error?: string };
      if (!res.ok || body.messages == null) {
        setMessagesError(body.error ?? "Could not load messages.");
        return;
      }
      // `prev == null` only right after a chat switch/initial load (that effect nulls it first) —
      // every other call here is the 6s poll, which must merge rather than replace.
      setMessages((prev) => (prev == null ? body.messages! : mergeLatest(body.messages!, prev)));
      setHasMore(!!body.hasMore);
      setMessagesError(undefined);
    } catch {
      setMessagesError("Could not reach the bot admin proxy.");
    }
  }, []);

  // Debounce the chat-list search box.
  useEffect(() => {
    const id = setTimeout(() => setChatQuery(chatQueryInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [chatQueryInput]);

  // Debounce the message-search box.
  useEffect(() => {
    const id = setTimeout(() => setMsgQuery(msgQueryInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [msgQueryInput]);

  // Chat list: initial load + 15s poll. Restarts when the debounced query/filter changes (a
  // fresh search should show up immediately, not wait out whatever was left of the old clock).
  useEffect(() => {
    if (!elevated) return;
    fetchChats();
    const id = setInterval(fetchChats, CHATS_POLL_MS);
    return () => clearInterval(id);
  }, [elevated, fetchChats]);

  // Auto-select the first chat once the list loads, but never re-steal an
  // existing selection on later polls.
  useEffect(() => {
    if (chats && chats.length > 0 && selectedChatId == null) {
      setSelectedChatId(chats[0].chatId);
    }
  }, [chats, selectedChatId]);

  // Selected thread: fetch on selection change + 6s poll.
  useEffect(() => {
    if (!elevated || !selectedChatId) return;
    setMessages(null);
    setMessagesError(undefined);
    setHasMore(false);
    fetchMessages(selectedChatId);
    const id = setInterval(() => fetchMessages(selectedChatId), MESSAGES_POLL_MS);
    return () => clearInterval(id);
  }, [elevated, selectedChatId, fetchMessages]);

  // Cross-chat message search: fires on the debounced query, empty query just clears the panel
  // (no need to round-trip an empty search — the bot returns [] for it anyway).
  useEffect(() => {
    if (!elevated) return;
    if (!msgQuery) {
      setSearchResults(null);
      setSearchError(undefined);
      setSearchPending(false);
      return;
    }
    let cancelled = false;
    setSearchPending(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/admin/bot/search?q=${encodeURIComponent(msgQuery)}&limit=${SEARCH_RESULT_LIMIT}`,
          { cache: "no-store" },
        );
        const body = (await res.json()) as { results: BotSearchResult[] | null; error?: string };
        if (cancelled) return;
        if (!res.ok || body.results == null) {
          setSearchError(body.error ?? "Could not search messages.");
          setSearchResults(null);
        } else {
          setSearchResults(body.results);
          setSearchError(undefined);
        }
      } catch {
        if (!cancelled) setSearchError("Could not reach the bot admin proxy.");
      } finally {
        if (!cancelled) setSearchPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [elevated, msgQuery]);

  // Restore scroll position after "Load older" prepends: without this the pane jumps to the
  // (now much earlier) top of the list instead of staying put on what the operator was reading.
  useLayoutEffect(() => {
    const el = threadScrollRef.current;
    const pending = scrollAdjustRef.current;
    if (el && pending) {
      el.scrollTop = pending.prevTop + (el.scrollHeight - pending.prevHeight);
      scrollAdjustRef.current = null;
    }
  }, [messages]);

  // Chat-list pagination: 30 rows per page. The reset key is the APPLIED filter (debounced query +
  // kind), not the `chats` array itself — the list refetches every 15s (CHATS_POLL_MS) on the same
  // filter, and resetting the page under an operator mid-scroll on every poll would be worse than
  // the stale-page bug this guards against. A shrinking list is still always clamped to a valid
  // page (see usePagination's doc comment) regardless of this key.
  const chatsPaging = usePagination(chats ?? [], 30, `${chatQuery}|${kindFilter}`);

  if (!elevated) {
    return (
      <Card title="Chats">
        <EmptyNote>The chat viewer is limited to superadmins/owners.</EmptyNote>
      </Card>
    );
  }

  function refresh() {
    fetchChats();
    if (selectedChatId) fetchMessages(selectedChatId);
  }

  function openSearchResult(r: BotSearchResult) {
    setSelectedChatId(r.chatId);
    setMsgQueryInput("");
    setMsgQuery("");
    setSearchResults(null);
  }

  // Paging backwards in the open thread. `beforeTs` is the oldest currently-loaded message's ts;
  // the response's `hasMore` decides whether the control stays visible afterwards.
  async function loadOlder() {
    if (!selectedChatId || !messages || messages.length === 0 || loadingOlder) return;
    const oldestTs = messages[0].ts;
    setLoadingOlder(true);
    const el = threadScrollRef.current;
    scrollAdjustRef.current = el ? { prevHeight: el.scrollHeight, prevTop: el.scrollTop } : null;
    try {
      const res = await fetch(
        `/api/admin/bot/chats/${encodeURIComponent(selectedChatId)}/messages?beforeTs=${oldestTs}`,
        { cache: "no-store" },
      );
      const body = (await res.json()) as { messages: BotChatMessage[] | null; hasMore?: boolean; error?: string };
      if (!res.ok || body.messages == null) {
        setMessagesError(body.error ?? "Could not load older messages.");
        return;
      }
      setMessages((prev) => [...body.messages!, ...(prev ?? [])]);
      setHasMore(!!body.hasMore);
    } catch {
      setMessagesError("Could not reach the bot admin proxy.");
    } finally {
      setLoadingOlder(false);
    }
  }

  return (
    <Card
      title="Chats"
      headerRight={
        <Button type="button" variant="ghost" size="sm" onClick={refresh}>
          Refresh
        </Button>
      }
    >
      {chatsError && <Toast message={chatsError} />}
      {messagesError && <Toast message={messagesError} />}

      <div className="bot-chats-toolbar">
        <div className="bot-search-group">
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Search chats</Eyebrow>
          <div className="bot-search-group__row">
            <input
              className="lux-field__control"
              type="search"
              aria-label="Search chats"
              placeholder="Filter by name or id…"
              value={chatQueryInput}
              onChange={(e) => setChatQueryInput(e.target.value)}
            />
            <select
              className="lux-field__control"
              aria-label="Filter chats by kind"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as "" | "group" | "dm")}
            >
              <option value="">All</option>
              <option value="group">Groups</option>
              <option value="dm">DMs</option>
            </select>
          </div>
        </div>

        <div className="bot-search-group bot-search-group--messages">
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Search messages (all chats)</Eyebrow>
          <input
            className="lux-field__control"
            type="search"
            aria-label="Search messages"
            placeholder="Search message text across every chat…"
            value={msgQueryInput}
            onChange={(e) => setMsgQueryInput(e.target.value)}
          />
        </div>
      </div>

      {msgQuery && (
        <div className="bot-message-search-results">
          {searchError && <Toast message={searchError} />}
          {searchError && searchResults == null ? (
            <EmptyNote>Message search couldn&apos;t be loaded — see the error above.</EmptyNote>
          ) : searchResults == null ? (
            <EmptyNote>{searchPending ? "Searching messages…" : "Waiting for search…"}</EmptyNote>
          ) : searchResults.length === 0 ? (
            <EmptyNote>No messages match &ldquo;{msgQuery}&rdquo;.</EmptyNote>
          ) : (
            <ul className="bot-search-result-list" role="list" aria-label="Message search results">
              {searchResults.map((r, i) => (
                <li key={`${r.chatId}-${r.ts}-${i}`}>
                  <button type="button" className="bot-search-result" onClick={() => openSearchResult(r)}>
                    <span className="bot-search-result__chat">{r.chatName}</span>
                    <span className="bot-search-result__meta">
                      {r.senderName} · {new Date(r.ts).toLocaleString("en-GB")}
                    </span>
                    <span className="bot-search-result__text">{r.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="bot-chats">
        <div className="bot-chats__list" role="list" aria-label="Chats">
          {chats == null ? (
            <EmptyNote>Loading chats…</EmptyNote>
          ) : chats.length === 0 ? (
            <EmptyNote>{chatQuery || kindFilter ? "No chats match this filter." : "No chats yet."}</EmptyNote>
          ) : (
            chatsPaging.pageItems.map((c) => (
              <button
                key={c.chatId}
                type="button"
                role="listitem"
                className={`bot-chat-row${c.chatId === selectedChatId ? " bot-chat-row--active" : ""}`}
                aria-pressed={c.chatId === selectedChatId}
                onClick={() => setSelectedChatId(c.chatId)}
              >
                <div className="bot-chat-row__head">
                  <span className="bot-chat-row__name">{c.name}</span>
                  <span className="bot-chat-row__time">{formatRelativeTime(c.lastActivityTs)}</span>
                </div>
                <div className="bot-chat-row__meta">
                  <span className={`bot-chat-badge bot-chat-badge--${c.surface}`}>
                    {c.surface === "whatsapp" ? "WA" : "TG"}
                  </span>
                  <span className="bot-chat-badge">{c.kind === "group" ? "Group" : "DM"}</span>
                  <span className="bot-chat-row__count">{c.messageCount}</span>
                </div>
                <p className="bot-chat-row__preview">{c.lastPreview}</p>
              </button>
            ))
          )}
        </div>

        <div className="bot-chats__thread" ref={threadScrollRef}>
          {!selectedChatId ? (
            <EmptyNote>Select a chat to view its messages.</EmptyNote>
          ) : messages == null && messagesError ? (
            // A failed fetch leaves `messages` null; without this branch the pane sat on
            // "Loading messages…" forever, which reads as a hang rather than an error.
            <EmptyNote>Messages couldn&apos;t be loaded — see the error above, then Refresh.</EmptyNote>
          ) : messages == null ? (
            <EmptyNote>Loading messages…</EmptyNote>
          ) : messages.length === 0 ? (
            <EmptyNote>No messages yet.</EmptyNote>
          ) : (
            <>
              {hasMore && (
                <div className="bot-load-older">
                  <Button type="button" variant="ghost" size="sm" onClick={loadOlder} disabled={loadingOlder}>
                    {loadingOlder ? "Loading…" : "Load older"}
                  </Button>
                </div>
              )}
              <div className="bot-thread" role="log" aria-label="Messages">
                {messages.map((m, i) => (
                  <div key={`${m.ts}-${i}`} className={`bot-bubble${m.fromBot ? " bot-bubble--bot" : ""}`}>
                    <div className="bot-bubble__meta">
                      <span className="bot-bubble__sender">{m.fromBot ? "Bot" : m.senderName}</span>
                      <span className="bot-bubble__time">{new Date(m.ts).toLocaleString("en-GB")}</span>
                    </div>
                    {m.text && <p className="bot-bubble__text">{m.text}</p>}
                    {(m.mediaMime || m.mediaStatus) && (
                      <div className="bot-bubble__media">
                        <span>
                          {m.mediaMime ?? "media"}
                          {m.mediaStatus ? ` · ${m.mediaStatus}` : ""}
                        </span>
                        {m.mediaText && <p className="bot-bubble__media-text">{m.mediaText}</p>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {chats != null && chats.length > 0 && (
        <Paginator
          page={chatsPaging.page}
          pageCount={chatsPaging.pageCount}
          rangeStart={chatsPaging.rangeStart}
          rangeEnd={chatsPaging.rangeEnd}
          total={chatsPaging.total}
          onPageChange={chatsPaging.setPage}
        />
      )}
    </Card>
  );
}
