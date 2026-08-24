"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";
import { NavLink } from "./NavLink";
import { type NavGroup } from "./nav";

const OPEN_DELAY = 120;
const CLOSE_DELAY = 200;

// One rail icon per group, its children in a flyout. Click is the primary
// interaction and hover only an accelerator: hover-only dies on touch laptops,
// which still get the rail (it is width-gated, not pointer-gated). The delays
// are what stop a cursor crossing the rail from strobing every panel open.
export function RailCategory({ group }: { group: NavGroup }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const wantFocus = useRef(false);
  const active = group.items.some((i) => i.href === pathname);
  const id = `rail-${group.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  function clear() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }

  function show() {
    const r = btn.current?.getBoundingClientRect();
    if (r) setTop(r.top);
    setOpen(true);
  }

  function schedule(next: boolean) {
    clear();
    timer.current = window.setTimeout(() => (next ? show() : setOpen(false)), next ? OPEN_DELAY : CLOSE_DELAY);
  }

  useEffect(() => clear, []);

  // Route changes mean the flyout did its job.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function links() {
    return Array.from(wrap.current?.querySelectorAll<HTMLElement>(".erp-railmenu a") ?? []);
  }

  // Keyboard-opened panels take focus; hover-opened ones must not steal it.
  useEffect(() => {
    if (!open || !wantFocus.current) return;
    wantFocus.current = false;
    links()[0]?.focus();
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape" && open) {
      setOpen(false);
      btn.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (!open) {
      wantFocus.current = true;
      show();
      return;
    }
    const items = links();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[Math.max(0, Math.min(items.length - 1, at + step))]?.focus();
  }

  return (
    <div
      className="erp-railcat"
      ref={wrap}
      onMouseEnter={() => schedule(true)}
      onMouseLeave={() => schedule(false)}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        ref={btn}
        className={`erp-navbtn erp-railcat__btn${active ? " erp-navbtn--active" : ""}`}
        aria-label={group.label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          clear();
          if (open) setOpen(false);
          else show();
        }}
      >
        <Icon name={group.icon ?? "box"} />
      </button>
      {open && (
        <div
          className="erp-railmenu"
          id={id}
          role="group"
          aria-label={group.label}
          style={{ top, maxHeight: `calc(100vh - ${top}px - 16px)` }}
        >
          <div className="erp-railmenu__title">{group.label}</div>
          {group.items.map((item) => (
            <NavLink key={item.href} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
