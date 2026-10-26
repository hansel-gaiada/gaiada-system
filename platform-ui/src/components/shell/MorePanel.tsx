"use client";
import { useEffect, useId, useRef, useState, useTransition, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Theme } from "@/lib/prefs";
import { setSkinChoiceAction } from "@/lib/prefsActions";
import { assistantDrawerHref } from "@/lib/assistantContext";
import { ASSISTANT_ROW } from "@/lib/workspaces";
import { countResults, exactResult, filterMore, resultHref, resultLabel, resultsAnnouncement, rowSubline, type MoreGroup, type MoreResult } from "@/lib/morePanel";
import { Icon } from "./icons";
import { RowCount } from "./RowCount";
import { ThemeToggle } from "./ThemeToggle";
import type { PaletteOpenDetail } from "./CommandPalette";
import "./more-panel.css";

// SCP-Kd (DW-D51, plan §6.2): the Social skin's More panel. The menu shrinks to its icon rail and this panel slides out beside it: a title, "Find a
// page", the person's Work, Performance and You rows exactly as the model gives them, and at the foot the account (every item the top bar's avatar
// menu offered, which the Social skin hides, plus the workspace switcher and the personal opt-out of the skin).
//
// A non-modal dialog (`role="dialog"`, labelled by its title): the page and the menu stay usable behind it. Opening moves focus to the field,
// Escape closes it and hands focus back to More (`anchor`), a press outside closes it, and Tab runs field, rows, then the account, in that order
// (the close button comes last in the document and is drawn at the top). Nothing here is a gate: the rows arrive already gated, and a tab found
// by the filter links to a page its row already offers.

export interface SidebarAccount {
  name: string;
  /** The person's title, else their email. */
  secondary: string;
  initials: string;
  /** The person is also a client contact: offer the portal (`UserMenu`'s "Client view"). */
  clientView: boolean;
  theme: Theme;
  /** The sign-out server action, handed down from the server (`logout`), as the avatar menu's form uses it. */
  logout: () => void | Promise<void>;
}

export function MorePanel({ id, groups, active, pathname, tenantId, account, switcher, anchor, onClose }: {
  id: string;
  groups: readonly MoreGroup[];
  active: { rowKey: string; tabKey: string } | null;
  pathname: string;
  tenantId: string | null;
  account: SidebarAccount | null;
  /** The workspace switcher, drawn inline (the one switcher of this skin). */
  switcher: ReactNode;
  /** The More button: a press on it is its own toggle, not "outside", and Escape returns focus to it. */
  anchor: RefObject<HTMLElement | null>;
  onClose: (returnFocus: boolean) => void;
}) {
  const titleId = useId();
  const [query, setQuery] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose(true);
    }
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [anchor, onClose]);

  const sections = filterMore(groups, query);
  const total = countResults(sections);

  function onFieldKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const typed = query.trim();
    if (!typed) return;
    const exact = exactResult(sections, typed);
    if (exact) {
      // Open the exact match as its link would: through the link, so the router and the close-on-click behave the same.
      Array.from(panel.current?.querySelectorAll<HTMLAnchorElement>("a[data-result]") ?? []).find((a) => a.dataset.result === resultKey(exact))?.click();
      return;
    }
    window.dispatchEvent(new CustomEvent<PaletteOpenDetail>("gaiada:palette:open", { detail: { query: typed } }));
  }

  return (
    <div className="ws-more" id={id} role="dialog" aria-labelledby={titleId} ref={panel}>
      <h2 className="ws-more__title" id={titleId}>More</h2>

      <div className="ws-more__find">
        <Icon name="search" size={20} stroke={2} />
        <input
          ref={field}
          type="search"
          className="ws-more__input"
          aria-label="Find a page"
          placeholder="Find a page"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFieldKeyDown}
        />
        <kbd aria-hidden="true">⌘K</kbd>
      </div>
      <p className="ws-more__sr" aria-live="polite" aria-atomic="true">{resultsAnnouncement(query, total)}</p>

      <div className="ws-more__scroll">
        {sections.length === 0 ? (
          <p className="ws-more__empty">No pages match “{query.trim()}”. Press Enter to search everywhere.</p>
        ) : (
          sections.map((s) => <Section key={s.key} label={s.label} results={s.results} active={active} pathname={pathname} tenantId={tenantId} onChoose={() => onClose(false)} />)
        )}
      </div>

      <div className="ws-more__foot">
        {account && (
          <div className="ws-more__me">
            <span className="ws-more__avatar" aria-hidden="true">{account.initials}</span>
            <span className="ws-more__who">
              <span className="ws-more__name">{account.name}</span>
              <span className="ws-more__sub">{account.secondary}</span>
            </span>
          </div>
        )}
        {switcher}
        {account && <Appearance theme={account.theme} />}
        {account && (
          <>
            <Link href="/account" className="ws-more__item" onClick={() => onClose(false)}>Account settings</Link>
            {account.clientView && <Link href="/portal" className="ws-more__item" onClick={() => onClose(false)}>Client view</Link>}
            <form action={account.logout}>
              <button type="submit" className="ws-more__item ws-more__item--danger">Log out</button>
            </form>
          </>
        )}
      </div>

      <button type="button" className="ws-more__close" aria-label="Close More" onClick={() => onClose(true)}>
        <Icon name="x" size={20} stroke={2} />
      </button>
    </div>
  );
}

const resultKey = (r: MoreResult) => (r.kind === "row" ? r.row.key : `${r.row.key}/${r.tab.key}`);

function Section({ label, results, active, pathname, tenantId, onChoose }: {
  label: string; results: MoreResult[]; active: { rowKey: string; tabKey: string } | null; pathname: string; tenantId: string | null; onChoose: () => void;
}) {
  const id = useId();
  return (
    <div className="ws-more__group" role="group" aria-labelledby={id}>
      <h3 className="ws-more__group-label" id={id}>{label}</h3>
      {results.map((r) => (
        <ResultLink key={resultKey(r)} result={r} active={active} pathname={pathname} tenantId={tenantId} onChoose={onChoose} />
      ))}
    </div>
  );
}

/** One result: a row (its icon, label, the grey list of its tabs where it holds several pages, its count) or a found tab (its label, the row it
 *  belongs to as the grey line). The AI Assistant row, were it listed, opens the drawer like the menu's own entry (no prefetch). */
function ResultLink({ result, active, pathname, tenantId, onChoose }: {
  result: MoreResult; active: { rowKey: string; tabKey: string } | null; pathname: string; tenantId: string | null; onChoose: () => void;
}) {
  const uid = useId();
  const labelId = `${uid}-l`;
  const subId = `${uid}-s`;
  const countId = `${uid}-c`;
  const row = result.row;
  const isRow = result.kind === "row";
  const sub = isRow ? rowSubline(row) : row.label;
  const count = isRow ? row.count : undefined;
  const current = active?.rowKey === row.key && (isRow || active.tabKey === result.tab.key);
  const assistant = row.key === ASSISTANT_ROW.key && isRow;
  const href = resultHref(result);
  return (
    <Link
      href={assistant && pathname !== href ? assistantDrawerHref(pathname, tenantId) : href}
      {...(assistant ? { prefetch: false } : {})}
      className={`ws-more__row${current ? " ws-more__row--active" : ""}`}
      aria-current={current ? "page" : undefined}
      aria-labelledby={count ? `${labelId} ${countId}` : labelId}
      aria-describedby={sub ? subId : undefined}
      data-result={resultKey(result)}
      onClick={onChoose}
    >
      <Icon name={isRow ? row.icon : (result.tab.icon ?? row.icon)} size={24} stroke={2} />
      <span className="ws-more__text">
        <span className="ws-more__label" id={labelId}>{resultLabel(result)}</span>
        {sub ? <span className="ws-more__sub" id={subId}>{sub}</span> : null}
      </span>
      {count ? <RowCount count={count} className="ws-more__count" id={countId} /> : null}
    </Link>
  );
}

/** Appearance: the theme (the same `ThemeToggle` and cookie as the avatar menu) and the personal opt-out of the skin (DW-D51), "Standard look":
 *  it writes the choice through `setSkinChoiceAction` and refreshes, so the layout rebuilds the model and the workspace is drawn Standard. The
 *  way back is the Standard avatar menu's "Use the <skin> look". */
function Appearance({ theme }: { theme: Theme }) {
  const router = useRouter();
  const [standard, setStandard] = useState(false);
  const [, startTransition] = useTransition();
  return (
    <div className="ws-more__appearance">
      <ThemeToggle theme={theme} />
      <button
        type="button"
        role="switch"
        aria-checked={standard}
        className="ws-more__item ws-more__switch"
        onClick={() => {
          const next = !standard;
          setStandard(next);
          startTransition(async () => {
            await setSkinChoiceAction(next ? "standard" : "workspace");
            router.refresh();
          });
        }}
      >
        <span>Standard look</span>
        <span className="ws-more__track" aria-hidden="true"><span className="ws-more__knob" /></span>
      </button>
    </div>
  );
}
