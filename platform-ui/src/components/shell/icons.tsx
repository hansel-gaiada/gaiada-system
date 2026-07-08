// Inline stroke icons, ported from the ERP prototype's `ic()` map. Every icon shares the same
// 1.6-stroke, round-cap/join style so the sidebar/topbar read as one system.
const PATHS = {
  home: "M4 11.5 12 4l8 7.5 M6 10v9h12v-9",
  finance: "M4 4h16v16H4z M4 9h16 M9 4v16",
  sales: "M3 12l5-6 4 4 6-7 3 3 M3 20h18",
  inventory: "M3 7l9-4 9 4-9 4-9-4z M3 7v10l9 4 9-4V7 M12 11v10",
  hr: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 20a6 6 0 0 1 12 0 M17 8a2.5 2.5 0 1 0 0-5 M17 12a5 5 0 0 1 4 8",
  manufacturing: "M3 20V10l4 3V10l4 3V10l4 3V6l4 3v11z",
  procurement: "M6 2v4 M10 2v4 M4 6h12v16H4z M20 10h-4",
  projects: "M4 5h16v3H4z M4 12h10v3H4z M4 19h7v3H4z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.5-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.5a7 7 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.6A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.2l-2 1.6 2 3.5 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.5a7 7 0 0 0 2-1.2l2.4 1 2-3.5-2-1.6c.067-.394.1-.795.1-1.2z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35",
  bell: "M6 8a6 6 0 0 1 12 0c0 4 1.5 6 1.5 6h-15S6 12 6 8z M10 20a2 2 0 0 0 4 0",
  plus: "M12 5v14 M5 12h14",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18 M6 6l12 12",
  wallet: "M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v3 M3 7v10a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1h-5a2 2 0 0 0 0 4h6",
  pulse: "M3 12h4l2 8 4-16 2 8h6",
  box: "M3 8l9-5 9 5-9 5-9-5z M3 8v9l9 5 9-5V8 M12 13v9",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 3",
  agents: "M9 8a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M5 21a7 7 0 0 1 14 0 M12 2v3",
  gateway: "M4 6h16v12H4z M4 12h16 M9 6v12",
  hub: "M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0 M12 4v5 M12 15v5 M4 12h5 M15 12h5",
  bot: "M7 7h10v9H7z M9 16v3 M15 16v3 M10 11h.01 M14 11h.01 M12 4v3",
  automation: "M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0 M12 8v4l3 2",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 19 }: { name: IconName; size?: number }) {
  const d = PATHS[name];
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" width={size} height={size} aria-hidden="true">
      {d.split(/(?= M)/).map((seg, i) => (
        <path key={i} d={seg.trim()} />
      ))}
    </svg>
  );
}
