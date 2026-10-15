import Link from "next/link";
import type { ReactNode } from "react";
import type { YourNumbers } from "@/lib/overviewNumbers";
import { formatDate } from "@/lib/format";
import { refusalText } from "@/lib/overviewWork";
import { DeltaChip } from "@/components/reports/charts/DeltaChip";
import { MY_ACTIVITY_HREF } from "@/components/overview/widgets/MyActivityBlock";
import {
  CHECKIN_HREF, MY_APPRAISALS_HREF, MY_LEARNING_HREF, MY_TIMESHEET_HREF,
  type AppraisalView, type CheckinsView, type LearningCounts, type Section, type TimeView,
} from "@/lib/myPerformance";
import "@/components/overview/overview.css";
import "./myPerformance.css";

// PV7-06: the sections of My performance. Each is a pure view of its own `Section`: a refused or failed read says
// "No access" or "Unavailable" in that section's place (never 0, never "no training"), a section whose module is off
// is not drawn, and the others are untouched. Each links to its full page; none copies it.
//
// Never drawn here: a composite score, utilization, hours beside the appraisal, or anyone else's data.

export interface MyPerformanceModel {
  numbers: Section<YourNumbers>;
  /** My report, for the same month. */
  numbersHref: string;
  checkins: Section<CheckinsView>;
  appraisal: Section<AppraisalView | null>;
  learning: Section<LearningCounts>;
  time: Section<TimeView>;
}

function Block({ label, state, children }: { label: string; state: string; children: ReactNode }) {
  return (
    <section className="ov-block" aria-label={label} data-state={state}>
      <h2 className="mp-block__title">{label}</h2>
      {children}
    </section>
  );
}

/** The read did not return data: say so in the section's own place. */
function Refused({ label, kind }: { label: string; kind: "forbidden" | "unavailable" }) {
  return (
    <Block label={label} state={kind}>
      <p className="ov-block__note">{refusalText(kind)}</p>
    </Block>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <li className="mp-stat">
      <span className="mp-stat__label">{label}</span>
      <span className="mp-stat__value">{value}</span>
    </li>
  );
}

function NumbersSection({ section, href }: { section: Section<YourNumbers>; href: string }) {
  if (section.kind === "off") return null;
  if (section.kind !== "ok") return <Refused label="Your numbers" kind={section.kind} />;
  const model = section.data;
  return (
    <Block label="Your numbers" state="ok">
      <p className="ov-block__note">{[model.periodLabel, model.comparison].filter(Boolean).join(" · ")}</p>
      <ul className="ov-nums__tiles">
        {model.tiles.map((t) => (
          <li key={t.key} className="ov-nums__tile">
            <span className="ov-nums__label">{t.label}</span>
            <span className={`ov-nums__value${t.noData ? " ov-nums__value--none" : ""}`}>{t.value}</span>
            {t.detail && <span className="ov-nums__detail">{t.detail}</span>}
            {t.delta && <DeltaChip delta={t.delta.change} direction={t.delta.direction} unit="count" magnitude={t.delta.magnitude} />}
          </li>
        ))}
      </ul>
      {model.note && <p className="ov-block__note" role="note">{model.note}</p>}
      <Link href={href} className="ov-nums__link">Open my report</Link>
    </Block>
  );
}

function CheckinsSection({ section }: { section: Section<CheckinsView> }) {
  if (section.kind === "off") return null;
  if (section.kind !== "ok") return <Refused label="Check-ins" kind={section.kind} />;
  const v = section.data;
  return (
    <Block label="Check-ins" state={v.entries.length === 0 ? "empty" : "ok"}>
      <ul className="mp-stats">
        <Stat label="Streak" value={v.streak === 1 ? "1 day" : `${v.streak} days`} />
        <Stat label="Compliance" value={v.rate ?? "No data"} />
      </ul>
      <p className="ov-block__note">
        {v.windowDays === 0
          ? "No check-ins recorded in the last 30 days."
          : `Last 30 days: ${v.submitted} submitted, ${v.missed} missed, ${v.excused} excused. An excused day never counts against you.`}
      </p>
      {v.entries.length > 0 && (
        // tabIndex: a scrollable region must be reachable by keyboard.
        <div className="mp-checkins__wrap" tabIndex={0} role="region" aria-label="Last check-ins">
          <table className="mp-checkins">
            <thead>
              <tr><th scope="col">Date</th><th scope="col">Status</th><th scope="col">Summary</th></tr>
            </thead>
            <tbody>
              {v.entries.map((e) => (
                <tr key={e.date}>
                  <td>{formatDate(e.date)}</td>
                  <td>{e.status}</td>
                  <td>{e.summary || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Link href={CHECKIN_HREF} className="ov-nums__link">Today&apos;s check-in</Link>
    </Block>
  );
}

function AppraisalSection({ section }: { section: Section<AppraisalView | null> }) {
  if (section.kind === "off") return null;
  if (section.kind !== "ok") return <Refused label="Appraisal" kind={section.kind} />;
  const a = section.data;
  return (
    <Block label="Appraisal" state={a ? "ok" : "empty"}>
      {a === null ? (
        <p className="ov-block__note">No appraisal yet</p>
      ) : (
        <>
          <p className="ov-work__health" data-part="cycle">{a.cycleName}</p>
          <p className="ov-work__meta" data-part="state">State: {a.statusText}</p>
          <p className="ov-work__meta" data-part="acknowledged">Acknowledged: {a.acknowledged ? "Yes" : "No"}</p>
        </>
      )}
      <Link href={MY_APPRAISALS_HREF} className="ov-nums__link">My appraisals</Link>
    </Block>
  );
}

function LearningSection({ section }: { section: Section<LearningCounts> }) {
  if (section.kind === "off") return null;
  if (section.kind !== "ok") return <Refused label="Learning" kind={section.kind} />;
  const c = section.data;
  return (
    <Block label="Learning" state={c.outstanding === 0 ? "empty" : "ok"}>
      <ul className="mp-stats">
        <Stat label="Outstanding" value={c.outstanding} />
        <Stat label="Mandatory" value={c.mandatory} />
        <Stat label="Overdue" value={c.overdue} />
      </ul>
      <Link href={MY_LEARNING_HREF} className="ov-nums__link">My learning</Link>
    </Block>
  );
}

function TimeSection({ section }: { section: Section<TimeView> }) {
  if (section.kind === "off") return null;
  if (section.kind !== "ok") return <Refused label="Your time" kind={section.kind} />;
  const t = section.data;
  return (
    <Block label="Your time" state="ok">
      <p className="ov-block__note">Context, not a score</p>
      <ul className="mp-stats">
        <Stat label={t.monthLabel} value={t.monthText} />
        <Stat label="Last 7 days" value={t.weekText} />
      </ul>
      <p className="ov-block__note">Hours from your own time entries.</p>
      <Link href={MY_TIMESHEET_HREF} className="ov-nums__link">My timesheet</Link>
    </Block>
  );
}

function ActivitySection() {
  return (
    <Block label="Activity" state="link">
      <p className="ov-block__note">Your year of activity, day by day.</p>
      <Link href={MY_ACTIVITY_HREF} className="ov-nums__link">Open my activity</Link>
    </Block>
  );
}

export function MyPerformance({ model }: { model: MyPerformanceModel }) {
  return (
    <div className="mp-grid">
      <NumbersSection section={model.numbers} href={model.numbersHref} />
      <CheckinsSection section={model.checkins} />
      <AppraisalSection section={model.appraisal} />
      <LearningSection section={model.learning} />
      <TimeSection section={model.time} />
      <ActivitySection />
    </div>
  );
}
