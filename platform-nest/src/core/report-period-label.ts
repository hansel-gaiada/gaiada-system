// SCP-5 W5-A2 (BFF §63.24.1) — the plain-words period of the periodic social report kinds. PURE: no I/O, so the report builder, the
// delivered title and tests can all use it without pulling in the database.
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "9 Nov 2026" for an ISO date. */
function dayLabel(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS_SHORT[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

/** SCP-5 W5-A2 (BFF §63.24.1): the plain-words period of the periodic social kinds: "9 Nov 2026" (daily), "9 to 15 Nov 2026" (weekly,
 *  "28 Dec 2026 to 3 Jan 2027" across a month's or a year's turn), "Q4 2026", "H2 2026" and "2026". Null for any other kind or period. */
export function periodicWhen(kind: string, period: string | null, start: string, end: string): string | null {
  const p = period?.trim() ?? "";
  if (kind === "daily" && /^\d{4}-\d{2}-\d{2}$/.test(p)) return dayLabel(p);
  if (kind === "weekly" && /^\d{4}-W\d{2}$/.test(p) && /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
    if (start.slice(0, 7) === end.slice(0, 7)) return `${Number(start.slice(8, 10))} to ${dayLabel(end)}`;
    if (start.slice(0, 4) === end.slice(0, 4)) return `${Number(start.slice(8, 10))} ${MONTHS_SHORT[Number(start.slice(5, 7)) - 1]} to ${dayLabel(end)}`;
    return `${dayLabel(start)} to ${dayLabel(end)}`;
  }
  if (kind === "quarterly" && /^\d{4}-Q[1-4]$/.test(p)) return `${p.slice(5)} ${p.slice(0, 4)}`;
  if (kind === "semester" && /^\d{4}-H[12]$/.test(p)) return `${p.slice(5)} ${p.slice(0, 4)}`;
  if (kind === "yearly" && /^\d{4}$/.test(p)) return p;
  return null;
}
