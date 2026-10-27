// SCP-1d (plan §6.2, §6.4; BFF §63.7, §63.4, §63.5) — the Social Media Home, drawn as the team's design lays it out: the client stories across the top, the feed of
// "Your turn" cards in the middle, "Waiting on others" under it, and a side column of the caller's accounts this cycle, tasks given to them and reports due.
//
// Pure over the reads' answers (a server component with no reads of its own: `SocialHome.tsx` makes them, in parallel), so every section has its own state:
//   ok          the section;
//   forbidden   "you don't have access" (a refused read);
//   unavailable "cannot tell", with the server's words. An empty list is only ever said when the read SUCCEEDED, so a failed read never reads as "nothing".
// One failed section never blanks the page: each is rendered on its own.
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { HomeTurnList } from "./HomeTurnList";
import { formatDate } from "@/lib/format";
import type { AgendaTaskRow } from "@/lib/agenda";
import type { ReadResult } from "@/lib/readResult";
import { REPORT_FORMAT_LABEL, cycleCountsText, type AllocationRow } from "@/lib/socialAllocation";
import { HEALTH_LABEL, type CycleTable } from "@/lib/socialCycles";
import { RING_TOKEN, dueWords, ordinal, reportsDue, storyCircles, type FeedPage } from "@/lib/socialHome";
import { clientConversationHref, holderTitle, postHref, statusWords, agoWords, type WaitingGroup } from "@/lib/socialMessages";
import "./cycles.css";
import "./social-home.css";

/** Posts listed under "Waiting on others" before the link to Messages (the whole list, with Follow up, lives there). */
export const WAITING_SHOWN = 6;
/** Tasks, accounts and reports listed in the side column. */
export const SIDE_SHOWN = 6;
export const ACCOUNTS_SHOWN = 12;

export interface SocialHomeReads {
  turn: ReadResult<FeedPage>;
  waiting: ReadResult<WaitingGroup[]>;
  tasks: ReadResult<AgendaTaskRow[]>;
  accounts: ReadResult<AllocationRow[]>;
  cycles: ReadResult<CycleTable>;
}

function Section({ id, title, children, className }: { id: string; title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`sh-section${className ? ` ${className}` : ""}`} aria-labelledby={id}>
      <h2 className="sh-section__title" id={id}>{title}</h2>
      {children}
    </section>
  );
}

/** A section whose read did not succeed: refused is "no access", anything else is "cannot tell", never an empty list. */
function Refused({ read, subject }: { read: Exclude<ReadResult<unknown>, { kind: "ok" }>; subject: string }) {
  return read.kind === "forbidden"
    ? <ReadRefusal inline subject={subject} kind="forbidden" detail="Reading it needs a Social Media read tier (the social_staff role, or a manager)." />
    : <ReadRefusal inline subject={subject} kind="unavailable" reason={read.reason} />;
}

export function SocialHomeView({ reads, deptId, userId, todayIso, nowIso }: { reads: SocialHomeReads; deptId: string; userId: string; todayIso: string; nowIso: string }) {
  const now = Date.parse(nowIso);
  const profile = (engagementId: string) => `/departments/${encodeURIComponent(deptId)}/profile/${encodeURIComponent(engagementId)}`;
  const { turn, waiting, tasks, accounts, cycles } = reads;

  return (
    <div className="sh" data-testid="social-home">
      <div className="sh-main">
        <Section id="sh-stories" title="Client stories" className="sh-section--stories">
          {cycles.kind !== "ok" ? <Refused read={cycles} subject="The client stories" /> : <Stories table={cycles.data} userId={userId} profile={profile} />}
        </Section>

        <Section id="sh-turn" title="Your turn">
          {turn.kind !== "ok" ? <Refused read={turn} subject="Your turn" /> : turn.data.items.length === 0 ? (
            <p className="scp-note" role="status">Nothing is waiting on you right now. When a post reaches your step, it shows up here.</p>
          ) : (
            <HomeTurnList cards={turn.data.items} deptId={deptId} hasMore={turn.data.hasMore} nowIso={nowIso} />
          )}
        </Section>

        <Section id="sh-waiting" title="Waiting on others">
          {waiting.kind !== "ok" ? <Refused read={waiting} subject="The posts waiting on others" /> : (
            <Waiting groups={waiting.data} deptId={deptId} now={now} />
          )}
        </Section>
      </div>

      <div className="sh-side">
        <Section id="sh-accounts" title="Your accounts this cycle">
          {accounts.kind !== "ok" ? <Refused read={accounts} subject="Your accounts" /> : accounts.data.length === 0 ? (
            <p className="scp-note" role="status">You are not the officer on any client yet. The Social Media head sets this on the Allocation page.</p>
          ) : (
            <ul className="sh-list">
              {accounts.data.slice(0, ACCOUNTS_SHOWN).map((a) => {
                const counts = cycleCountsText(a);
                return (
                  <li key={a.engagementId}>
                    <Link href={profile(a.engagementId)} className="sh-row">
                      <span className="sh-row__main">{a.clientName}</span>
                      <span className="sh-row__sub">
                        {counts ? <>{counts.main} posts{counts.beside ? ` · ${counts.beside}` : ""}</> : "No cycle this month"}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section id="sh-tasks" title="Tasks given to you">
          {tasks.kind !== "ok" ? <Refused read={tasks} subject="Your tasks" /> : tasks.data.length === 0 ? (
            <p className="scp-note" role="status">No open task is assigned to you.</p>
          ) : (
            <>
              <ul className="sh-list">
                {tasks.data.slice(0, SIDE_SHOWN).map((t) => (
                  <li key={`${t.source}:${t.id}`}>
                    <Link href={t.href} className="sh-row">
                      <span className="sh-row__main">{t.title}</span>
                      <span className="sh-row__sub">{t.dueDate ? `Due ${formatDate(t.dueDate)}` : "No due date"} · {t.status}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="sh-more-link"><Link href="/me/tasks" className="scp-link">{tasks.data.length > SIDE_SHOWN ? `All ${tasks.data.length} tasks` : "Open My tasks"}</Link></p>
            </>
          )}
        </Section>

        <Section id="sh-reports" title="Reports due">
          {accounts.kind !== "ok" ? <Refused read={accounts} subject="The reports due" /> : <ReportsDue rows={accounts.data} todayIso={todayIso} profile={profile} />}
        </Section>
      </div>
    </div>
  );
}

function Stories({ table, userId, profile }: { table: CycleTable; userId: string; profile: (id: string) => string }) {
  const circles = storyCircles(table, userId);
  if (circles.length === 0) {
    return <p className="scp-note" role="status">You are not the officer on any client yet, so there are no stories to show.</p>;
  }
  return (
    <ul className="sh-stories" aria-label="Clients, with their schedule health">
      {circles.map((c) => (
        <li key={c.engagementId}>
          <Link href={profile(c.engagementId)} className="sh-story">
            <span className="sh-ring" style={{ "--sh-ring": RING_TOKEN[c.state] } as CSSProperties} data-state={c.state} aria-hidden="true">
              <span className="sh-ring__face">{c.clientName.charAt(0).toUpperCase()}</span>
            </span>
            <span className="sh-story__name">{c.clientName}</span>
            <span className="sh-story__state" aria-hidden="true">{c.state === "none" ? "No cycle" : HEALTH_LABEL[c.state]}</span>
            <span className="sh-sr">{c.words}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Waiting({ groups, deptId, now }: { groups: WaitingGroup[]; deptId: string; now: number }) {
  if (groups.length === 0) {
    return <p className="scp-note" role="status">Nothing of yours is waiting on anyone. When you send a post on and someone else holds it, it shows up here.</p>;
  }
  const total = groups.reduce((n, g) => n + g.posts.length, 0);
  let left = WAITING_SHOWN;
  return (
    <>
      {groups.map((g) => {
        const posts = g.posts.slice(0, Math.max(0, left));
        left -= posts.length;
        if (posts.length === 0) return null;
        return (
          <div key={g.holder.role} className="sh-wgroup">
            <h3 className="sh-wgroup__title">{holderTitle(g.holder.role, g.holder.label)}</h3>
            <ul className="sh-list">
              {posts.map((p) => (
                <li key={p.id}>
                  <div className="sh-row sh-row--split">
                    <Link href={postHref(deptId, p.id)} className="sh-row__link">
                      <span className="sh-row__main">{p.title}</span>
                      <span className="sh-row__sub">{p.clientName} · {statusWords(p.pipelineStatus)} · waiting {agoWords(p.since, now).replace(/ ago$/, "")}</span>
                    </Link>
                    {g.holder.role === "client" && p.clientId !== "" && (
                      <Link href={clientConversationHref(p.clientId)} className="scp-link">Open the conversation</Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <p className="sh-more-link">
        <Link href={`/departments/${encodeURIComponent(deptId)}/messages`} className="scp-link">
          {total > WAITING_SHOWN ? `All ${total} in Messages, with Follow up` : "Open Messages, to follow up"}
        </Link>
      </p>
    </>
  );
}

function ReportsDue({ rows, todayIso, profile }: { rows: AllocationRow[]; todayIso: string; profile: (id: string) => string }) {
  const due = reportsDue(rows, todayIso);
  if (due.length === 0) {
    return <p className="scp-note" role="status">None of your clients has a report due day set. The Social Media head sets it on the Allocation page.</p>;
  }
  return (
    <>
      <ul className="sh-list">
        {due.slice(0, SIDE_SHOWN).map((r) => (
          <li key={r.engagementId}>
            <Link href={profile(r.engagementId)} className="sh-row">
              <span className="sh-row__main">{r.clientName}</span>
              <span className="sh-row__sub">
                {dueWords(r.daysLeft)} · the {ordinal(r.dueDay)}{r.format ? ` · ${REPORT_FORMAT_LABEL[r.format]}` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="scp-note">Due days come from each client&rsquo;s allocation. Whether a report is drafted or sent is not shown here yet.</p>
    </>
  );
}
