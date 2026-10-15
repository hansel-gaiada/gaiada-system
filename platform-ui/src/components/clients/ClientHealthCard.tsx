import Link from "next/link";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ClientVisibilityMarker } from "./ClientVisibilityMarker";
import { ClientHealthChip } from "./ClientHealthChip";
import { formatDate } from "@/lib/format";
import {
  CLIENT_SIDE_KINDS, COULD_NOT_BE_LOADED, SOURCE_LABEL, STATE_MEANING, TURNAROUND_KIND_LABEL,
  describeReason, healthDate, turnaroundValue,
  type ClientHealthDetail, type HealthReason, type ProjectHealth, type Turnaround,
} from "@/lib/clientHealth";

// PV7-03 — the staff hub's Health card (BFF §54.2, `GET :t/clients/:clientId/health`).
//
// ── PLACEMENT, AND WHY NOTHING IS LISTED TWICE ──────────────────────────────────────────────────────
// The hub already lists the items that are waiting (Waiting on us, Waiting on the client) and this card sits BELOW them.
// So it never lists those items: a waiting reason is a sentence with a count and an oldest date ("2 items waiting on us
// for 7 days or more"), and the card says the items are listed above. The state chip is the one new thing; the
// per-project health and the reply times are the other two.
//
// ── THE STATE IS STAFF-ONLY ─────────────────────────────────────────────────────────────────────────
// The chip is a summary for the account team and is never a score (L3). The portal gets the facts, never this label.
//
// ── A FAILED READ IS NOT A STATE ────────────────────────────────────────────────────────────────────
// `health === null` (the whole read failed) says so in words. A section that is `null` inside a payload (projects,
// turnaround) says "Could not be loaded" the same way; a `null` is never drawn as zero or as an empty list.

const WAITING_CODES: ReadonlySet<HealthReason["code"]> = new Set(["waiting_on_us_7d", "waiting_on_us_14d", "waiting_on_client_14d"]);

function ProjectRow({ p }: { p: ProjectHealth }) {
  const m = p.milestones;
  const d = p.deliverables;
  return (
    <tr data-project={p.projectId}>
      <td>
        <Link href={`/projects/${p.projectId}`} className="ch-health__link">{p.name}</Link>
        <ClientVisibilityMarker clientVisible={p.clientVisible} />
      </td>
      <td>{p.status.replace(/_/g, " ")}</td>
      <td>
        {m.done} done · {m.upcoming} upcoming · <span className={m.late > 0 ? "ch-health__late" : undefined}>{m.late} late</span>
        {m.undated > 0 && ` · ${m.undated} undated`}
      </td>
      <td>
        {d.delivered} of {d.total} delivered · <span className={d.late > 0 ? "ch-health__late" : undefined}>{d.late} late</span>
      </td>
      <td>{p.nextMilestone ? `${p.nextMilestone.name}, ${formatDate(p.nextMilestone.dueDate)}` : "None dated"}</td>
    </tr>
  );
}

function TurnaroundRow({ label, t, marker }: { label: string; t: Pick<Turnaround, "medianDays" | "n" | "withheld">; marker?: boolean | null }) {
  return (
    <div className="ch-health__ta-row">
      <dt>
        {label}
        {marker !== undefined && <ClientVisibilityMarker clientVisible={marker} />}
      </dt>
      <dd>
        {turnaroundValue(t)}
        {t.withheld ? ` (${t.n} so far, 3 needed)` : ` (${t.n} ${t.n === 1 ? "reply" : "replies"})`}
      </dd>
    </div>
  );
}

export function ClientHealthCard({ health }: { health: ClientHealthDetail | null }) {
  if (health === null) {
    return (
      <Card title="Health">
        <p className="ch-health__note" role="status">Health: {COULD_NOT_BE_LOADED}. The lists above are still current.</p>
      </Card>
    );
  }
  const waitingReason = health.reasons.some((r) => WAITING_CODES.has(r.code));
  const ta = health.turnaround;
  const clientParts = ta ? ta.client.parts.filter((x) => CLIENT_SIDE_KINDS.has(x.kind)) : [];
  const ourParts = ta ? ta.ours.parts.filter((x) => !CLIENT_SIDE_KINDS.has(x.kind)) : [];
  return (
    <Card
      title="Health"
      headerRight={
        <ClientHealthChip state={health.state} />
      }
      hint="A summary for the account team, worked out from what is waiting, late, overdue or down. It is never shown to the client, who sees the facts instead."
    >
      <div className="ch-health">
        <div data-part="reasons">
          <p className="ch-health__meaning">{STATE_MEANING[health.state]}</p>
          {health.reasons.length > 0 && (
            <ul className="ch-health__reasons">
              {health.reasons.map((r) => <li key={r.code} data-reason={r.code}>{describeReason(r)}</li>)}
            </ul>
          )}
          {waitingReason && <p className="ch-health__note">The waiting items themselves are listed above.</p>}
          {health.unavailable.length > 0 && (
            <p className="ch-health__note" role="status">
              {COULD_NOT_BE_LOADED}: {health.unavailable.map((s) => SOURCE_LABEL[s]).join(", ")}.
            </p>
          )}
        </div>

        <div data-part="projects">
          <h4 className="ch-health__h">Projects</h4>
          {health.projects === null ? (
            <p className="ch-health__note" role="status">Projects: {COULD_NOT_BE_LOADED}</p>
          ) : health.projects.length === 0 ? (
            <EmptyNote>This client has no projects yet.</EmptyNote>
          ) : (
            <div className="ch-health__scroll">
              <table className="ch-health__table">
                <caption className="ch-health__cap">Health of each project of this client</caption>
                <thead>
                  <tr><th scope="col">Project</th><th scope="col">Status</th><th scope="col">Milestones</th><th scope="col">Deliverables</th><th scope="col">Next milestone</th></tr>
                </thead>
                <tbody>{health.projects.map((p) => <ProjectRow key={p.projectId} p={p} />)}</tbody>
              </table>
            </div>
          )}
          {health.onTimeKnownSince && (
            <p className="ch-health__note">On-time history is recorded from {healthDate(health.onTimeKnownSince)}. Milestones finished before then carry no completion date.</p>
          )}
        </div>

        <div data-part="turnaround">
          <h4 className="ch-health__h">Reply times, last {ta?.windowDays ?? 90} days</h4>
          {ta === null ? (
            <p className="ch-health__note" role="status">Reply times: {COULD_NOT_BE_LOADED}</p>
          ) : (
            <div className="ch-health__ta">
              <dl>
                <TurnaroundRow label="Client, all together" t={ta.client} />
                {clientParts.map((x) => <TurnaroundRow key={x.kind} label={TURNAROUND_KIND_LABEL[x.kind]} t={x} marker={x.clientVisible} />)}
              </dl>
              <dl>
                <TurnaroundRow label="Us, all together" t={ta.ours} />
                {ourParts.map((x) => <TurnaroundRow key={x.kind} label={TURNAROUND_KIND_LABEL[x.kind]} t={x} marker={x.clientVisible} />)}
              </dl>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
