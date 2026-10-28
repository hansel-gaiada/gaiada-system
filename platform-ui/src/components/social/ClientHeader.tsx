// SCP-1k — the client page's header (plan §8 row 1k): the client, its officer, the count against the monthly target (stories and extra posts beside it, never
// in it), the cycle line (month, deadline, ready-by and the client's health), the tone in one line and the cycle's highlights. It draws what the server
// answered: the counts are `GET allocation`'s `thisCycle`, the health and the posts are `GET cycles/:cycleId/health`'s.
// SCP-Sg adds the followers line from `GET engagements/:engagementId/accounts-summary`: followers with the 30-day change, the 30-day reach, a SIMULATED chip when
// the numbers are the simulator's, and "Last synced <time>" (or "Not synced yet"). A refused or failed read says so in words, never "0".
import { HealthChip } from "./HealthChip";
import { SimulatedAccountChip } from "./SimulatedAccountChip";
import { CREATIVE_SOURCE_LABEL, NETWORK_LABEL, cycleCountsText, type AllocationRow } from "@/lib/socialAllocation";
import { cycleHighlights, monthTitle, type CycleView } from "@/lib/socialClient";
import { formatDate } from "@/lib/format";
import {
  SUMMARY_FORBIDDEN_TEXT, SUMMARY_SIMULATED_NOTE, SUMMARY_UNAVAILABLE_TEXT, countText, deltaText, lastSyncedText, type AccountsSummaryRead,
} from "@/lib/socialAccountsSummary";

export function ClientHeader({
  row, cycle, cycleUnavailable, tone, summary,
}: {
  row: AllocationRow;
  /** The cycle's posts and health; null with no cycle this month, or when they could not be read (`cycleUnavailable`). */
  cycle: CycleView | null;
  cycleUnavailable?: boolean;
  /** The tone in one line: a string, null for a client with none, undefined when the brand book could not be read. */
  tone: string | null | undefined;
  /** SCP-Sg: the client's accounts read back. Omitted by a caller that does not read it (nothing is drawn then, and nothing claimed). */
  summary?: AccountsSummaryRead;
}) {
  const counts = cycleCountsText(row);
  const high = cycle ? cycleHighlights(cycle.posts) : null;
  return (
    <header className="scp-chead">
      <div className="scp-chead__top">
        <h2 className="scp-chead__name">{row.clientName}</h2>
        <p className="scp-chead__meta">
          {row.officer ? `Officer: ${row.officer.name}` : "No officer yet"} · {CREATIVE_SOURCE_LABEL[row.creativeSource]}
          {row.platforms.length > 0 ? ` · ${row.platforms.map((p) => NETWORK_LABEL[p] ?? p).join(", ")}` : ""}
        </p>
      </div>
      <p className="scp-chead__line">
        {counts ? (
          <>
            <span className="scp-chead__count" aria-label="Posts counted against the monthly target">{counts.main}</span>
            <span>{row.postsPerCycle !== null ? "posts of the target" : "posts, no target set"}</span>
            {counts.beside && <span className="scp-chead__beside">Beside the target: {counts.beside}</span>}
          </>
        ) : (
          <span>No cycle this month, so no posts are counted yet.</span>
        )}
      </p>
      {summary && <FollowersLine summary={summary} />}
      <p className="scp-chead__line">
        {row.thisCycle ? (
          cycle ? (
            <>
              <span>{monthTitle(cycle.month)}</span>
              <span>Deadline {formatDate(cycle.deadline)}</span>
              <span>Ready by {formatDate(cycle.readyBy)}</span>
              <HealthChip health={cycle.client} />
            </>
          ) : (
            <span>{cycleUnavailable ? "The cycle's deadline and health could not be read just now." : monthTitle(row.thisCycle.month)}</span>
          )
        ) : (
          <span>A Social Media head sets this month&rsquo;s deadline in Settings; a post can be added once the cycle exists.</span>
        )}
      </p>
      <p className="scp-chead__tone">
        {tone === undefined ? "The tone could not be read just now." : tone ? `Tone: ${tone}` : "No tone set yet. Add it in Client profile."}
      </p>
      {high && (
        <ul className="scp-highlights" aria-label="Cycle highlights">
          <li className="scp-highlight"><b>{high.late}</b> late</li>
          <li className="scp-highlight"><b>{high.atRisk}</b> at risk</li>
          <li className="scp-highlight"><b>{high.withClient}</b> with the client</li>
          <li className="scp-highlight"><b>{high.changesAsked}</b> with client changes</li>
          <li className="scp-highlight"><b>{high.approvedOrLater}</b> approved or posted</li>
        </ul>
      )}
    </header>
  );
}

/** SCP-Sg: followers (with the 30-day change), the 30-day reach, the SIMULATED mark and the last sync, from the accounts read back. */
function FollowersLine({ summary }: { summary: AccountsSummaryRead }) {
  if (summary.kind === "forbidden") return <p className="scp-chead__line scp-chead__beside">{SUMMARY_FORBIDDEN_TEXT}</p>;
  if (summary.kind === "unavailable") return <p className="scp-chead__line scp-chead__beside" role="status">{SUMMARY_UNAVAILABLE_TEXT}</p>;
  const { accounts, totals, simulated, lastSyncedAt } = summary.data;
  if (accounts.length === 0) return <p className="scp-chead__line scp-chead__beside">No social accounts yet, so there are no followers to show.</p>;
  // The 30-day change of the whole client: the accounts' changes added, only when every account that reported followers also has a change (a partial sum would lie).
  const reporting = accounts.filter((a) => a.followers !== null);
  const delta = reporting.length > 0 && reporting.every((a) => a.followersDelta30d !== null)
    ? reporting.reduce((n, a) => n + (a.followersDelta30d as number), 0) : null;
  return (
    <p className="scp-chead__line" aria-label="Followers, reach and last sync">
      {totals.followers === null ? (
        <span>Followers not reported yet</span>
      ) : (
        <>
          <span className="scp-chead__count" aria-label="Followers">{countText(totals.followers)}</span>
          <span>followers{delta !== null ? ` (${deltaText(delta)})` : ""}</span>
        </>
      )}
      {totals.reach30d === null ? (
        <span>Reach not reported yet</span>
      ) : (
        <>
          <span className="scp-chead__count" aria-label="Reach in the last 30 days">{countText(totals.reach30d)}</span>
          <span>reach in 30 days</span>
        </>
      )}
      {simulated && <><SimulatedAccountChip /><span className="scp-chead__beside">{SUMMARY_SIMULATED_NOTE}</span></>}
      <span className="scp-chead__beside">{lastSyncedText(lastSyncedAt)}</span>
    </p>
  );
}
