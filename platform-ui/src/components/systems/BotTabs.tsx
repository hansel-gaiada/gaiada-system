"use client";
import { useState, type ReactNode } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import "./systems.css";

// Client-side tab switcher for the bot page (`?tab=` deep-linkable). Each
// panel is rendered SERVER-SIDE by the page.tsx Server Component (Connect/
// Groups/Config keep their existing server-fetched data + server actions
// unchanged) and simply passed in as a ReactNode prop here — only the
// active/inactive SWITCHING is client-side.
//
// Inactive tabs are unmounted (not just CSS-hidden): this is what actually
// stops ChatsTab/LogsTab's polling when their tab isn't selected — there is
// no separate "is tab active" flag to keep in sync with the DOM.
export type BotTabKey = "connect" | "controls" | "chats" | "groups" | "logs" | "config";

const TABS: { key: BotTabKey; label: string }[] = [
  { key: "connect", label: "Connect" },
  { key: "controls", label: "Controls" },
  { key: "chats", label: "Chats" },
  { key: "groups", label: "Groups" },
  { key: "logs", label: "Logs" },
  { key: "config", label: "Config" },
];

const TAB_KEYS = new Set<string>(TABS.map((t) => t.key));

export function isBotTabKey(v: string | null): v is BotTabKey {
  return v != null && TAB_KEYS.has(v);
}

export function BotTabs(props: Record<BotTabKey, ReactNode>) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  // Deep-link on first paint from ?tab=, then own the active tab as local
  // state — switching must be instant and must not depend on the Next.js
  // router actually re-delivering a changed useSearchParams() value.
  const initial = sp.get("tab");
  const [active, setActive] = useState<BotTabKey>(isBotTabKey(initial) ? initial : "connect");

  function go(key: BotTabKey) {
    if (key === active) return;
    setActive(key);
    const params = new URLSearchParams(sp.toString());
    params.set("tab", key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <>
      <nav className="bot-tabs" role="tablist" aria-label="Bot sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active === t.key}
            className={`bot-tab${active === t.key ? " bot-tab--active" : ""}`}
            onClick={() => go(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div role="tabpanel">{props[active]}</div>
    </>
  );
}
