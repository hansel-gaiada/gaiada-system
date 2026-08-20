import Link from "next/link";
import { TeachState } from "./TeachState";

// Cross-source work timeline for a department (F2 `work_activity`, decision
// #2/#3 in web-dev-phase1-tickets.md): PM events today, GitHub/Drive once
// Phase-2 lands their auto-link rules. This component only renders rows —
// the caller fetches `/api/:t/work-activity`, sorts newest-first, and passes
// the array; grouping-by-day here is pure display math on `occurredAt`, not
// a fetch. Dept-agnostic: `source` is a fixed enum shared by every department
// (nothing Web-Dev-specific), and the empty state teaches the same way for all.
//
// It is also the ONE chronological object on the department Home, so the DATE
// carries the structure: each day's number is set large in the display face on a
// left axis, and the rows hang off it. Everything that was doing that job before
// is gone — the vertical spine, the per-row node, and the source column in front
// of each sentence — because five markers (spine · node · source · row rule ·
// day rule) were competing to organise one list, and the axis does it with two.
// Every other block on that page (KPI strip, health rings, launchers, team) has
// no time axis and cannot borrow the device.
export type ActivitySource = "pm" | "pipeline" | "github" | "google_drive" | "claude" | "manual" | "system";

export interface ActivityItem {
  id: string;
  /** Display name of who did it; omitted for system-generated rows. */
  actor?: string | null;
  /** true when no PLATFORM PERSON performed this — a cron, an agent, a webhook. Not derivable
   *  from `actor` being empty: `actorLabel()` falls back to `actorExternal`, so a scheduler row
   *  arrives carrying the name "scheduler" and looks exactly like a colleague. The caller knows
   *  (`!row.actorUserId`); this component would only be guessing. */
  automated?: boolean;
  /** Already humanized by the caller, e.g. "created", "commented on", "shipped". */
  verb: string;
  /** e.g. "Task: Fix login redirect", "Doc: Q3 brief". */
  objectLabel: string;
  href?: string;
  /** ISO timestamp. */
  occurredAt: string;
  source?: ActivitySource;
}

export interface ActivityFeedProps {
  /** Newest-first. The component groups consecutive same-day rows; it does not re-sort. */
  items: ActivityItem[];
  /** "Now", as an ISO timestamp resolved by the CALLER. Both current callers are server
   *  components, so the `new Date()` this replaces was not a hydration mismatch — it was worse in
   *  a quieter way: "Today" was decided by the SERVER's clock and zone, so a request just after
   *  local midnight in Asia/Makassar (still yesterday in UTC) labelled today's rows "Yesterday".
   *  Passing the instant in also keeps the component pure, so its labels are testable and the day
   *  it thinks it is cannot drift between the two render sites. Same contract as `MyWorkRail`'s
   *  precomputed `urgencyTier`. Omit it and the feed drops the relative labels entirely — an
   *  absolute date is never wrong, a guessed one is. */
  nowIso?: string;
  /** true when the caller had more rows than it passed, so the feed can say so instead of
   *  looking like the whole history. */
  truncated?: boolean;
  emptyTitle?: string;
  emptyBody?: string;
  emptyCtaLabel?: string;
  emptyCtaHref?: string;
}

const SOURCE_LABEL: Record<ActivitySource, string> = {
  pm: "PM",
  pipeline: "Pipeline",
  github: "GitHub",
  google_drive: "Drive",
  claude: "Claude",
  manual: "Manual",
  system: "System",
};

// Every date read here is pinned to ONE locale and ONE zone. `toLocale*(undefined, …)` resolves
// against whatever ICU the runtime has — and this component renders on the SERVER, so that
// runtime was the container: times were being printed in UTC, eight hours off the working day,
// and nothing threw. Zone follows the `me/inbox` precedent: a timestamp carrying a time of day
// belongs in the reader's day, not the container's (an event at 23:30Z is the NEXT local day, and
// the grouping has to agree with the clock beside it).
const ZONE = "Asia/Makassar";
const LOCALE = "en-GB";

/** Sortable local day key, e.g. "2026-07-22". en-CA is the locale whose short date IS ISO order. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-CA", { timeZone: ZONE });
}

/** The date split for the axis: "22" and "JUL" are set separately, at different sizes. Parsed at
 *  UTC noon and formatted in UTC — `key` is ALREADY a local day, so re-reading it in ZONE would
 *  shift it a second time and print the wrong number. */
function dayParts(key: string): { num: string; month: string } | null {
  const d = new Date(`${key}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return {
    num: d.toLocaleDateString(LOCALE, { day: "numeric", timeZone: "UTC" }),
    month: d.toLocaleDateString(LOCALE, { month: "short", timeZone: "UTC" }),
  };
}

/** Whole days between two day keys. Both are parsed at UTC noon so no zone or DST edge can shift
 *  the difference by one. */
function daysBetween(fromKey: string, toKey: string): number | null {
  const a = new Date(`${fromKey}T12:00:00Z`).getTime();
  const b = new Date(`${toKey}T12:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // 24-hour, two digits, matching `me/inbox` — the app already pins en-GB everywhere it formats a
  // date, and one clock convention across the surface beats a friendlier one in a single card.
  return d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", timeZone: ZONE });
}

interface DayGroup {
  key: string;
  /** "Today" · "Yesterday" · "22 Jul". The heading's accessible text; the axis renders the parts. */
  label: string;
  /** Set for a dated day: the two halves the axis sets at different sizes. Null for today and
   *  yesterday, where a word beats a number the reader has to convert. */
  parts: { num: string; month: string } | null;
  /** "28d ago" — omitted for today/yesterday, where the word already says it. */
  age?: string;
  /** true only for today and yesterday, where a clock time still tells the reader something. */
  showTimes: boolean;
  items: ActivityItem[];
}

function groupByDay(items: ActivityItem[], nowIso?: string): DayGroup[] {
  const todayKey = nowIso ? dayKey(nowIso) : null;
  const groups: DayGroup[] = [];
  for (const item of items) {
    const key = dayKey(item.occurredAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
      continue;
    }
    const age = todayKey ? daysBetween(key, todayKey) : null;
    // The clock is only worth showing while it still situates the event. On a row three weeks old,
    // "5:10 PM" is precision with nothing to attach to; the day marker is the whole answer.
    const recent = age !== null && age <= 1;
    const parts = dayParts(key);
    groups.push({
      key,
      label: age === 0 ? "Today" : age === 1 ? "Yesterday" : parts ? `${parts.num} ${parts.month}` : key,
      parts: recent ? null : parts,
      // Compact because the axis column is narrow: "28 days ago" wrapped to three lines under a
      // 26px numeral and turned the axis into a paragraph.
      age: age !== null && age > 1 ? `${age}d ago` : undefined,
      showTimes: recent,
      items: [item],
    });
  }
  return groups;
}

export function ActivityFeed({ items, nowIso, truncated, emptyTitle, emptyBody, emptyCtaLabel, emptyCtaHref }: ActivityFeedProps) {
  if (items.length === 0) {
    return (
      <TeachState
        glyph="◐"
        title={emptyTitle ?? "No activity yet"}
        body={emptyBody ?? "Work from PM, repos, and docs will show up here as soon as it happens."}
        ctaLabel={emptyCtaLabel}
        ctaHref={emptyCtaHref}
      />
    );
  }

  const groups = groupByDay(items, nowIso);

  return (
    <div className="dept-activity">
      {groups.map((g) => (
        <section key={g.key} className="dept-activity__day-group">
          {/* The date IS the structure. It was a small eyebrow above the rows and the feed needed a
              spine, nodes, and a source column to look organised; set as a numeral in the display
              face on its own axis, it does that work alone, and all three of those went away. */}
          <h4 className="dept-activity__date">
            {g.parts ? (
              <>
                <span className="dept-activity__date-num">{g.parts.num}</span>
                <span className="type-eyebrow dept-activity__date-month">{g.parts.month}</span>
              </>
            ) : (
              /* Today and yesterday keep the word: a reader who knows today is the 19th still has
                 to convert "19" back, and the whole point of the axis is that it needs no arithmetic. */
              <span className="dept-activity__date-rel">{g.label}</span>
            )}
            {g.age && <span className="dept-activity__age">{g.age}</span>}
          </h4>
          <ol className="dept-activity__list">
            {g.items.map((item) => {
              // A cron run and a colleague's decision used to sit at identical weight, so the feed
              // answered "what happened" but never "who has been working".
              const machine = item.automated ?? !item.actor;
              const source = item.source ?? "system";
              const body = (
                <>
                  <span className="dept-activity__text">
                    {/* Only a person's name is set in bold. A scheduler's is a label, and bolding
                        it put a cron at the same weight as a colleague's decision. */}
                    {item.actor && (machine ? <span>{item.actor}</span> : <strong>{item.actor}</strong>)}
                    {item.actor ? " " : ""}{item.verb}{" "}
                    <span className="dept-activity__object">{item.objectLabel}</span>
                  </span>
                  {/* Right-hand cluster: the annotations, in one place. Provenance was a 58px column
                      IN FRONT of the sentence, which held "PM" in a well wide enough for
                      "PIPELINE" and left a gap between the marker and the name it belonged to.
                      As a right-aligned annotation it stays scannable as a column without
                      standing between the reader and the sentence. */}
                  <span className="dept-activity__meta">
                    {g.showTimes && <span className="dept-activity__time">{timeLabel(item.occurredAt)}</span>}
                    {/* The one mark that survives the spine's removal, because it is the one thing
                        the sentence cannot say: `actorLabel` gives a scheduler a name, so without
                        this a cron reads as a colleague. */}
                    {machine && <span className="dept-activity__auto" role="img" aria-label="Automated" title="Automated" />}
                    <span className="dept-activity__source">{SOURCE_LABEL[source]}</span>
                  </span>
                </>
              );
              return (
                <li key={item.id} className={`dept-activity__item${machine ? " dept-activity__item--machine" : ""}`}>
                  {item.href ? (
                    <Link href={item.href} className="dept-activity__row dept-activity__row--link">{body}</Link>
                  ) : (
                    <span className="dept-activity__row">{body}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {truncated && <p className="dept-activity__more">Last {items.length} shown.</p>}
    </div>
  );
}
