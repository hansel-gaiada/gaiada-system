"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { Button, Card, HairlineTable, StatusBadge } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { formatDateTime } from "@/lib/format";
import { environmentLabel, HOST_KIND_COPY } from "@/lib/webdeskPortfolio";
import {
  ASSIGNEE_COPY, CHECKLIST_COPY, CLOSED_BY_COPY, PROPERTY_COPY, REASON_COPY, RECORDS_OWNER_COPY, TASK_STATE_COPY,
  observedLine, recheckSentence, taskHref,
  type DnsRead, type Recheck, type SiteDns, type SiteDnsTask,
} from "@/lib/siteDnsModel";
import type { RecheckResult } from "@/lib/siteDnsActions";
import "./webdesk.css";

// M6-P6i + M6-P6p — the "Domain and DNS" card on the site console page. Two INDEPENDENT reads, each with its own failure sentence: the
// checklist (what records the domain needs, what public DNS answers now) and the DNS task (the PM task that asks a person to create them).
//
// Rules this file keeps, because the failure it closes is a confident wrong answer:
//   · a read that FAILED draws its sentence in its own place (ReadRefusal), never an empty records table and never "no task";
//   · "no task" is drawn only for an answer whose `state` said `none`;
//   · `pointing` is the only "done" word, and `lookup_failed` is never worded as "not pointing";
//   · the one write is "Check DNS now", offered to a viewer the server is likely to allow; the server decides.

export function SiteDnsCard({
  dns, task, canRecheck, onRecheck,
}: {
  dns: DnsRead<SiteDns>;
  task: DnsRead<SiteDnsTask>;
  /** Cosmetic early exit (`can()`); the server's 403 is the real answer and is shown as a sentence. */
  canRecheck: boolean;
  onRecheck: () => Promise<RecheckResult>;
}) {
  const [result, setResult] = useState<Recheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // After a recheck the task is the one in the answer, even if the page's own task read had failed.
  const shownTask: DnsRead<SiteDnsTask> = result ? { state: "ok", data: result.task } : task;

  function run() {
    setError(null);
    startTransition(async () => {
      try {
        const r = await onRecheck();
        if (r.ok) setResult({ task: r.task, check: r.check });
        else { setResult(null); setError(r.message); }
      } catch {
        setResult(null);
        setError("The DNS check could not be run just now. Nothing was changed. Try again in a moment.");
      }
    });
  }

  return (
    <Card
      title="Domain and DNS"
      hint="A read-only view. The ERP stores no DNS credential and changes no record: a person creates them, and the ERP checks the domain itself, read-only."
      style={{ marginTop: 16 }}
    >
      <section aria-label="DNS checklist">
        <p className="type-eyebrow wd-pf__label wd-dns__label">Checklist</p>
        {dns.state === "ok"
          ? <Checklist dns={dns.data} />
          : <ReadRefusal inline subject={dns.kind === "forbidden" ? "this site's DNS checklist" : "The DNS checklist"} kind={dns.kind} reason={dns.message} />}
      </section>

      <section aria-label="DNS task" className="wd-dns__section">
        <p className="type-eyebrow wd-pf__label wd-dns__label">DNS task</p>
        {shownTask.state === "ok"
          ? <TaskBlock task={shownTask.data} />
          : <ReadRefusal inline subject={shownTask.kind === "forbidden" ? "this site's DNS task" : "The DNS task"} kind={shownTask.kind} reason={shownTask.message} />}

        {result ? <p role="status" className="wd-dns__result">{recheckSentence(result)}</p> : null}
        {error ? <p role="alert" className="wd-consent__error">{error}</p> : null}

        {canRecheck ? (
          <p className="wd-dns__actions">
            <Button size="sm" variant="ghost" onClick={run} disabled={pending}>{pending ? "Checking…" : "Check DNS now"}</Button>
            <span className="wd-consent__hint">Looks the domain up now. When every record points, the task is closed.</span>
          </p>
        ) : null}
      </section>
    </Card>
  );
}

function Checklist({ dns }: { dns: SiteDns }) {
  const c = dns.checklist;
  return (
    <>
      <div className="wd-site__chips">
        <StatusBadge label={environmentLabel(dns.environment)} />
        <span>{dns.domain}</span>
        <span className="wd-pf__dim">{HOST_KIND_COPY[dns.hostKind] ?? dns.hostKind}{dns.hostRef ? ` · ${dns.hostRef}` : ""}</span>
      </div>

      <p className="wd-dns__line">{RECORDS_OWNER_COPY[dns.recordsOwner]}</p>
      <p className="wd-dns__line"><strong>{c.state === "ready" ? "Ready." : "Not ready."}</strong> {CHECKLIST_COPY[c.state]}</p>

      {c.records.length > 0 ? (
        <HairlineTable
          columns={[{ label: "Type" }, { label: "Name" }, { label: "Target" }]}
          tcols="80px 2fr 3fr"
          rows={c.records.map((r) => [r.type, r.name, r.target])}
        />
      ) : null}
      {c.instruction ? <p className="wd-dns__line">{c.instruction}</p> : null}

      <p className="type-eyebrow wd-pf__label wd-dns__label">What DNS answers now</p>
      <Observed observed={dns.observed} />

      <p className="wd-dns__line">
        {dns.check.state === "pointing"
          ? <><StatusBadge label="pointing" /> <span>Every address DNS answers is this site&apos;s host. The records are in place.</span></>
          : <><StatusBadge label="pending" /> <span>{dns.check.reason ? REASON_COPY[dns.check.reason] : ""}</span></>}
      </p>
      <p className="wd-consent__hint">Checked {formatDateTime(dns.checkedAt)}, when this page was loaded.</p>
      <p className="wd-consent__hint">{PROPERTY_COPY[dns.property.state]}</p>
    </>
  );
}

function Observed({ observed }: { observed: SiteDns["observed"] }) {
  if (observed === null) {
    return <p className="wd-dns__line">DNS was not asked: there are no records to compare it with yet.</p>;
  }
  return (
    <>
      <ul className="wd-dns__observed">
        <li>{observedLine("A", observed.a)}</li>
        <li>{observedLine("AAAA", observed.aaaa)}</li>
        <li>{observedLine("CNAME", observed.cname)}</li>
      </ul>
      {observed.error ? <p className="wd-consent__error">The lookup reported an error: {observed.error}</p> : null}
    </>
  );
}

function TaskBlock({ task }: { task: SiteDnsTask }) {
  if (task.state === "none") return <p className="wd-dns__line">{TASK_STATE_COPY.none}</p>;
  return (
    <>
      <div className="wd-site__chips">
        <StatusBadge label={task.state} />
        <span>{TASK_STATE_COPY[task.state]}</span>
      </div>
      <p className="wd-dns__line">{task.assigneeSource ? ASSIGNEE_COPY[task.assigneeSource] : "Who it is assigned to is not recorded."}</p>
      {task.taskId ? (
        <p className="wd-dns__line"><Link href={taskHref(task.taskId)}>Open the task</Link></p>
      ) : null}
      {task.state === "closed" ? (
        <p className="wd-dns__line">
          {task.closedBy ? CLOSED_BY_COPY[task.closedBy] : ""} {task.closedAt ? `Closed ${formatDateTime(task.closedAt)}.` : "The closing time is not recorded."}
        </p>
      ) : null}
      <p className="wd-dns__line">
        {task.lastCheckedAt
          ? <>Last checked {formatDateTime(task.lastCheckedAt)}. {task.lastCheckReason ? REASON_COPY[task.lastCheckReason] : "That check found the records pointing."}</>
          : "The ERP has not checked this domain for the task yet."}
      </p>
      <p className="wd-dns__line">
        {task.erpSawPointing ? "The ERP saw the records point." : "The ERP has not seen the records point."}
      </p>
    </>
  );
}
