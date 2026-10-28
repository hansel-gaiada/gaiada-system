"use client";
// SCP-4b (BFF §63.11, §63.17) — the Boosting page's body, three parts: CANDIDATES (live posts well above their client's average, each with a "Boost" button that opens the request dialog),
// RUNNING AND WAITING (the boosts the read lists, filterable by status and by client; each row links to its post), and TOTALS (what the listed boosts commit of the months' budgets, and
// what they spent). A SIMULATED boost says so on its row.
//
// IT DRAWS `GET boosts` AND DECIDES NOTHING. The filters narrow the page the server sent (the contract's list takes `status` and `engagementId`, but a client is named, not numbered, in the
// answer, so the page filters what it was sent and says so when more pages exist). The list carries no officer, so the Boost button is offered on every candidate and the server's refusal
// ("only the client's officer, the HoD or the GM runs a boost") is said in words in the dialog. Boost money is the client's own ad spend, never our fees.
import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BoostChip } from "@/components/social/BoostCard";
import { BoostRequestDialog } from "@/components/social/BoostRequestDialog";
import {
  BOOST_GOAL_LABEL, BOOST_STATUSES, boostStatusLabel, daysText, formatBoostCount, formatBoostMoney, plainDate, ratePercent, type BoostCandidate, type BoostGoal, type BoostList, type BoostRow,
} from "@/lib/socialBoosts";
import "@/components/social/cycles.css";
import "@/components/social/post-page.css";
import "@/components/social/boosts.css";

export function BoostBoard({ deptId, data, nextHref }: { deptId: string; data: BoostList; nextHref?: string | null }) {
  const uid = useId();
  const router = useRouter();
  const [asking, setAsking] = useState<BoostCandidate | null>(null);
  const [status, setStatus] = useState("");
  const [client, setClient] = useState("");
  const { items, candidates, totals } = data;
  const clients = useMemo(() => [...new Set([...items.map((b) => b.clientName), ...candidates.map((c) => c.clientName)].filter(Boolean))].sort(), [items, candidates]);
  const shown = items.filter((b) => (!status || b.status === status) && (!client || b.clientName === client));
  const postHref = (id: string) => `/departments/${encodeURIComponent(deptId)}/posts/${encodeURIComponent(id)}`;
  const money = (n: number | null, b: Pick<BoostRow, "currency" | "minorUnit">) => formatBoostMoney(n, b.currency, b.minorUnit);

  return (
    <div className="scp-boosts">
      <section className="scp-boosts__section" aria-labelledby={`${uid}-cand`}>
        <h3 className="scp-boosts__h" id={`${uid}-cand`}>Candidates</h3>
        {candidates.length === 0 ? (
          <p className="scp-note" role="status">No live post is well above its client&apos;s average right now, so there is nothing to suggest. A post you choose yourself can still be boosted from its own page.</p>
        ) : (
          <>
            <p className="scp-field__hint" style={{ margin: 0 }}>Live posts whose engagement rate is well above their client&apos;s average of the last 90 days, and that have no boost yet.</p>
            <ul className="scp-boostrows" aria-label="Boost candidates">
              {candidates.map((c) => (
                <li key={c.postId} className="scp-boostrow" data-post-id={c.postId}>
                  <div className="scp-boostrow__main">
                    <Link className="scp-boostrow__title" href={postHref(c.postId)}>{c.title || "Untitled post"}</Link>
                    <span className="scp-boostrow__meta">
                      <span>{c.clientName}</span>
                      <span>Engagement rate {ratePercent(c.engagementRate)}</span>
                      <span>Client&apos;s average {ratePercent(c.accountAverageRate)}</span>
                    </span>
                  </div>
                  <div className="scp-boostrow__side">
                    <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" aria-label={`Boost ${c.title || "this post"}`} onClick={() => setAsking(c)}>Boost</button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="scp-boosts__section" aria-labelledby={`${uid}-list`}>
        <h3 className="scp-boosts__h" id={`${uid}-list`}>Running and waiting</h3>
        <div className="scp-boostfilters" role="group" aria-label="Filter the boosts">
          <div className="scp-field">
            <label htmlFor={`${uid}-status`}>Status</label>
            <select id={`${uid}-status`} className="scp-input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {BOOST_STATUSES.map((s) => <option key={s} value={s}>{boostStatusLabel(s)}</option>)}
            </select>
          </div>
          <div className="scp-field">
            <label htmlFor={`${uid}-client`}>Client</label>
            <select id={`${uid}-client`} className="scp-input" value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="">All clients</option>
              {clients.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        {items.length === 0 ? (
          <p className="scp-note" role="status">No boosts yet. A boost is requested from a live post.</p>
        ) : shown.length === 0 ? (
          <p className="scp-note" role="status">No boost matches these filters.{nextHref ? " More boosts are on the next page." : ""}</p>
        ) : (
          <ul className="scp-boostrows" aria-label="Boosts">
            {shown.map((b) => (
              <li key={b.id} className="scp-boostrow" data-boost-id={b.id}>
                <div className="scp-boostrow__main">
                  <Link className="scp-boostrow__title" href={postHref(b.postId)}>{b.postTitle || "Untitled post"}</Link>
                  <span className="scp-boostrow__meta">
                    <span>{b.clientName}</span>
                    <span>{BOOST_GOAL_LABEL[b.goal as BoostGoal] ?? b.goal}</span>
                    <span>{money(b.totalBudgetMinor, b)} over {daysText(b.days)}</span>
                    <span>From {plainDate(b.startsOn)}</span>
                    {(b.status === "stopped" || b.status === "completed") && (
                      <span>Spent {money(b.spendMinor, b)}, paid reach {formatBoostCount(b.paidReach)}, clicks {formatBoostCount(b.clicks)}</span>
                    )}
                  </span>
                </div>
                <div className="scp-boostrow__side"><span><BoostChip status={b.status} simulated={b.simulated} /></span></div>
              </li>
            ))}
          </ul>
        )}
        {(status || client) && nextHref && <p className="scp-field__hint" style={{ margin: 0 }}>The filters narrow this page of boosts. <Link className="scp-link" href={nextHref}>Show the next boosts</Link>.</p>}
        {!(status || client) && nextHref && <p style={{ margin: 0 }}><Link className="scp-link" href={nextHref}>Show the next boosts</Link></p>}
      </section>

      <section className="scp-boosts__section" aria-labelledby={`${uid}-tot`}>
        <h3 className="scp-boosts__h" id={`${uid}-tot`}>Totals</h3>
        <dl className="scp-boosttotals" aria-label="Totals of the listed boosts">
          <div><dt>Committed</dt><dd>{formatBoostMoney(totals.committedMinor, totals.currency)}</dd></div>
          <div><dt>Spend so far</dt><dd>{formatBoostMoney(totals.spendMinor, totals.currency)}</dd></div>
        </dl>
        <p className="scp-field__hint" style={{ margin: 0 }}>
          Committed is the full budget of each approved or running boost plus what each stopped or completed one actually spent; a waiting, cancelled or declined boost commits nothing.
          These are the client&apos;s own ad budgets, not our fees.
        </p>
      </section>

      {asking && <BoostRequestDialog postId={asking.postId} postTitle={asking.title} onClose={() => setAsking(null)} onRequested={() => router.refresh()} />}
    </div>
  );
}
