"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, Button, Toast } from "@/components/ui";
import { EmptyNote } from "./EmptyNote";
import { formatRelativeTime } from "@/lib/timeFormat";
import "./systems.css";

// Read-only WhatsApp/Telegram-style two-pane chat viewer (frozen nest contract
// `/api/admin/bot/chats` + `/api/admin/bot/chats/:chatId/messages`), reached
// through this app's own no-store proxy routes (never the platform directly —
// tokens never reach the browser, same as WhatsAppConnect's session poll).
//
// CRITICAL: every piece of chat content here (name, lastPreview, senderName,
// text, mediaText) is UNTRUSTED — it is rendered EXCLUSIVELY as a plain React
// text child below. There is no dangerouslySetInnerHTML, no markdown-to-HTML
// conversion, anywhere in this file.
//
// Polling: the chat list polls every ~15s and the selected thread every ~6s,
// both only while this component is mounted (i.e. the Chats tab is active —
// BotTabs unmounts inactive tabs, which is what actually stops the interval;
// there is no separate "is tab active" flag to get out of sync).
const CHATS_POLL_MS = 15_000;
const MESSAGES_POLL_MS = 6_000;

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

export function ChatsTab({ elevated }: { elevated: boolean }) {
  const [chats, setChats] = useState<BotChatSummary[] | null>(null);
  const [chatsError, setChatsError] = useState<string | undefined>();
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BotChatMessage[] | null>(null);
  const [messagesError, setMessagesError] = useState<string | undefined>();

  const fetchChats = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/bot/chats", { cache: "no-store" });
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
  }, []);

  const fetchMessages = useCallback(async (chatId: string) => {
    try {
      const res = await fetch(`/api/admin/bot/chats/${encodeURIComponent(chatId)}/messages`, { cache: "no-store" });
      const body = (await res.json()) as { messages: BotChatMessage[] | null; error?: string };
      if (!res.ok || body.messages == null) {
        setMessagesError(body.error ?? "Could not load messages.");
        return;
      }
      setMessages(body.messages);
      setMessagesError(undefined);
    } catch {
      setMessagesError("Could not reach the bot admin proxy.");
    }
  }, []);

  // Chat list: initial load + 15s poll.
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
    fetchMessages(selectedChatId);
    const id = setInterval(() => fetchMessages(selectedChatId), MESSAGES_POLL_MS);
    return () => clearInterval(id);
  }, [elevated, selectedChatId, fetchMessages]);

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

      <div className="bot-chats">
        <div className="bot-chats__list" role="list" aria-label="Chats">
          {chats == null ? (
            <EmptyNote>Loading chats…</EmptyNote>
          ) : chats.length === 0 ? (
            <EmptyNote>No chats yet.</EmptyNote>
          ) : (
            chats.map((c) => (
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

        <div className="bot-chats__thread">
          {!selectedChatId ? (
            <EmptyNote>Select a chat to view its messages.</EmptyNote>
          ) : messages == null ? (
            <EmptyNote>Loading messages…</EmptyNote>
          ) : messages.length === 0 ? (
            <EmptyNote>No messages yet.</EmptyNote>
          ) : (
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
          )}
        </div>
      </div>
    </Card>
  );
}
