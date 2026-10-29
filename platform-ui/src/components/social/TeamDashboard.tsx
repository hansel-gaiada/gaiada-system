// SCP-5d (BFF §63.19): the Team dashboard's sections, drawn from one `TeamDashboard` answer: Needs attention, Clients this cycle, Workload per person, Where work
// waits longest, Step averages and Estimates not set. The KPI strip and the pipeline tiles sit above them, drawn by the page.
//
// Honesty rules the page keeps: an empty list is a CLAIM (the server said there is nothing), so every section has its own empty sentence; a part the server could
// not work out (`partial`) is named as unknown and its section does not claim to be empty; `personRowsLimited` is one quiet line under the two per-person sections.
// Waiting time is counted against whoever holds the post (the holder), never the client's officer, and the page says so. Server-renderable: no state.
import Link from "next/link";
import {
  ATTENTION_LABEL, ATTENTION_WORDS, HEALTH_LABEL, HOLDER_NOTE, LIMITED_NOTE, WAIT_ROLE_LABEL, WORK_ROLE_LABEL,
  attentionGroups, attentionHref, clientHref, clientsByHealth, holderText, partialText, postsCount, postsText, settingsHref, sinceText, stepLabel,
  waitsSorted, workingDaysText, workloadSorted, type TeamDashboard,
} from "@/lib/socialTeam";
import { HealthChip } from "./HealthChip";
import "./cycles.css";
import "./teamDashboard.css";

/** A section's "unknown, not empty" line when the server named this part in `partial`. */
const Unknown = ({ what }: { what: string }) => (
  <p className="std-note" role="status" data-state="unknown">{`The ${what} could not be worked out this time, so nothing is claimed about it.`}</p>
);

export function TeamDashboard({ data, deptId }: { data: TeamDashboard; deptId: string }) {
  const partial = new Set(data.partial);
  const partialLine = partialText(data.partial);
  return (
    <div className="std-sections">
      {partialLine && <p className="std-note std-note--partial" role="status" data-testid="partial">{partialLine}</p>}

      <section aria-labelledby="std-attention" data-section="needs-attention">
        <h3 className="scp-section__title" id="std-attention">Needs attention</h3>
        {partial.has("needsAttention") ? <Unknown what="needs-attention list" /> : data.needsAttention.length === 0 ? (
          <p className="std-empty">Nothing needs attention this month.</p>
        ) : (
          <div className="std-groups">
            {attentionGroups(data.needsAttention).map((g) => (
              <div key={g.kind} className="std-group" data-kind={g.kind}>
                <h4 className="std-group__title">{ATTENTION_LABEL[g.kind]} <span className="std-count">{g.items.length}</span></h4>
                <p className="std-group__words">{ATTENTION_WORDS[g.kind]}</p>
                <ul className="std-list">
                  {g.items.map((it, i) => {
                    const holder = holderText(it.holder);
                    return (
                      <li key={`${g.kind}-${it.postId ?? it.reportId ?? it.boostId ?? it.engagementId}-${i}`} className="std-row">
                        <Link href={attentionHref(deptId, it)} className="std-row__main">
                          <span className="std-row__client">{it.clientName}</span>
                          {it.title && <span className="std-row__title">{it.title}</span>}
                        </Link>
                        <span className="std-row__meta">{sinceText(it.since)}{holder ? ` · With ${holder}` : ""}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="std-clients" data-section="clients">
        <h3 className="scp-section__title" id="std-clients">Clients this cycle</h3>
        {partial.has("clients") ? <Unknown what="client list" /> : data.clients.length === 0 ? (
          <p className="std-empty">No client has an open engagement this month.</p>
        ) : (
          <div className="scp-tablewrap">
            <table className="scp-table">
              <caption>Each client&rsquo;s posts against its monthly target, and its schedule health.</caption>
              <thead>
                <tr><th scope="col">Client</th><th scope="col">Target</th><th scope="col">Counted</th><th scope="col">Approved</th><th scope="col">Live</th><th scope="col">Beside the target</th><th scope="col">Health</th></tr>
              </thead>
              <tbody>
                {clientsByHealth(data.clients).map((c) => {
                  const pt = postsText(c);
                  return (
                    <tr key={c.engagementId} data-health={c.health?.state ?? "none"}>
                      <td>
                        <Link href={clientHref(deptId, c.engagementId)} className="scp-table__client">{c.clientName}</Link>
                        <span className="scp-table__sub">{c.officer ? `Officer: ${c.officer.name}` : "No officer yet"}</span>
                      </td>
                      <td className="scp-table__num">{c.target ?? "Not set"}</td>
                      <td className="scp-table__num">{pt.main}</td>
                      <td className="scp-table__num">{c.approved}</td>
                      <td className="scp-table__num">{c.live}</td>
                      <td>{pt.beside ?? "None"}</td>
                      <td><HealthChip health={c.health} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="std-note">Health: {Object.values(HEALTH_LABEL).join(", ")}. A client with no cycle this month reads &ldquo;No cycle&rdquo;.</p>
          </div>
        )}
      </section>

      <section aria-labelledby="std-workload" data-section="workload">
        <h3 className="scp-section__title" id="std-workload">Workload per person</h3>
        <p className="std-note std-note--first">{HOLDER_NOTE}</p>
        {partial.has("workload") ? <Unknown what="workload" /> : data.workload.length === 0 ? (
          <p className="std-empty">{data.personRowsLimited ? "No person's row is shown to you for this month." : "Nobody holds a post this month."}</p>
        ) : (
          <div className="scp-tablewrap">
            <table className="scp-table">
              <caption>Posts each person holds now, and how many of them are late.</caption>
              <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Holding</th><th scope="col">Late</th><th scope="col">Oldest</th></tr></thead>
              <tbody>
                {workloadSorted(data.workload).map((w) => (
                  <tr key={`${w.userId}-${w.role}`}>
                    <td className="scp-table__client">{w.name || "A colleague"}</td>
                    <td>{WORK_ROLE_LABEL[w.role]}</td>
                    <td className="scp-table__num">{postsCount(w.holding)}</td>
                    <td className="scp-table__num">{w.late}</td>
                    <td>{w.oldestSince ? sinceText(w.oldestSince) : "None waiting"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="std-waits" data-section="waits">
        <h3 className="scp-section__title" id="std-waits">Where work waits longest</h3>
        <p className="std-note std-note--first">{HOLDER_NOTE}</p>
        {partial.has("waits") ? <Unknown what="waiting times" /> : data.waits.length === 0 ? (
          <p className="std-empty">No post is waiting on anyone this month.</p>
        ) : (
          <ul className="std-list std-waits">
            {waitsSorted(data.waits).map((w) => (
              <li key={w.holderRole} className="std-wait" data-role={w.holderRole}>
                <div className="std-wait__head">
                  <span className="std-wait__role">{WAIT_ROLE_LABEL[w.holderRole]}</span>
                  <span className="std-row__meta">{postsCount(w.posts)} · {sinceText(w.oldestSince)} · average {workingDaysText(w.averageWorkingDays)}</span>
                </div>
                {w.people.length > 0 && (
                  <ul className="std-people">
                    {w.people.map((p) => (
                      <li key={p.userId}>{p.name || "A colleague"}: {postsCount(p.posts)}{p.oldestSince ? `, ${sinceText(p.oldestSince).toLowerCase()}` : ""}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        {data.personRowsLimited && <p className="std-note" data-testid="limited">{LIMITED_NOTE}</p>}
      </section>

      <section aria-labelledby="std-steps" data-section="step-averages">
        <h3 className="scp-section__title" id="std-steps">Step averages</h3>
        {partial.has("stepAverages") ? <Unknown what="step averages" /> : data.stepAverages.length === 0 ? (
          <p className="std-empty">No post has moved through a step this month, so there is no average yet.</p>
        ) : (
          <div className="scp-tablewrap">
            <table className="scp-table">
              <caption>Working days a post spent in each step this month.</caption>
              <thead><tr><th scope="col">Step</th><th scope="col">Average</th><th scope="col">Posts measured</th></tr></thead>
              <tbody>
                {data.stepAverages.map((s) => (
                  <tr key={s.step}><td className="scp-table__client">{stepLabel(s.step)}</td><td>{workingDaysText(s.averageWorkingDays)}</td><td className="scp-table__num">{s.samples}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="std-estimates" data-section="estimates-not-set">
        <h3 className="scp-section__title" id="std-estimates">Estimates not set</h3>
        {partial.has("estimatesNotSet") ? <Unknown what="estimates list" /> : data.estimatesNotSet.length === 0 ? (
          <p className="std-empty">Every client has its step estimates set.</p>
        ) : (
          <>
            <p className="std-note std-note--first">Without them a post shows only its ready-by date, not the latest safe day to hand it on. <Link href={settingsHref(deptId)} className="scp-link">Set them in Settings</Link>.</p>
            <ul className="std-list">
              {data.estimatesNotSet.map((c) => (
                <li key={c.engagementId} className="std-row"><Link href={clientHref(deptId, c.engagementId)} className="std-row__main"><span className="std-row__client">{c.clientName}</span></Link></li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
