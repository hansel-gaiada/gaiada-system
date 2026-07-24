// Pure, client-safe relative-time formatter (deliberately NOT "server-only" —
// unlike lib/admin.ts, this is imported directly by client components, e.g.
// ChatsTab/LogsTab, which poll live admin surfaces and need to format
// timestamps in the browser on every render/tick).
//
// Internal admin console only — plain second/minute/hour/day granularity,
// no Intl.RelativeTimeFormat locale nuance needed.
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts)) return "—";
  const diffMs = now - ts;
  if (diffMs < 1000) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
