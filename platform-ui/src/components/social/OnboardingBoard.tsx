"use client";
// SCP-5h (BFF §63.29.5): the clients being onboarded. Each card: the client, its officer, the kickoff, the progress, the next step with its due day, the baseline audit and the project
// it belongs to; the checklist by phase opens beneath. A tick closes the PM task through PM's own route (the server decides who may), "Move kickoff" re-dates the open steps, and
// "Start onboarding" applies the company's template (the four; the button says who may, and why it cannot be used when the client has no project or the company no template).
// Nothing here grants anything: a refusal is shown in words, beside the control that made it.
import { useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefusalNote } from "@/components/social/PostRefusal";
import { formatDate } from "@/lib/format";
import { newUuid } from "@/lib/socialClient";
import {
  allocationHref, auditHref, groupByPhase, lateCount, progressPercent, progressText, projectHref, startBlockWords,
  type Onboarding, type OnboardingItem, type OnboardingStep,
} from "@/lib/socialOnboarding";
import { moveKickoff, openBaselineAudit, startOnboarding, tickStep } from "@/lib/socialOnboardingActions";
import "./cycles.css";
import "./onboarding.css";

type Form = { kind: "start" | "move"; engagementId: string } | null;
interface Said { engagementId: string; message: string; error: string }

export function OnboardingBoard({ deptId, data, today }: { deptId: string; data: Onboarding; today: string }) {
  const router = useRouter();
  const uid = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [form, setForm] = useState<Form>(null);
  const [kickoff, setKickoff] = useState(today);
  const [said, setSaid] = useState<Said | null>(null);
  const [pending, run] = useTransition();
  // One id per start dialog: a retry of the same click is the same application on the server.
  const startId = useRef<string>("");

  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const fail = (engagementId: string, r: { error: string; message: string }) => setSaid({ engagementId, message: r.message, error: r.error });

  function openForm(kind: "start" | "move", i: OnboardingItem) {
    setSaid(null);
    setKickoff(kind === "move" && i.kickoff ? i.kickoff : today);
    startId.current = newUuid();
    setForm({ kind, engagementId: i.engagementId });
  }
  function submit(i: OnboardingItem) {
    setSaid(null);
    run(async () => {
      const r = form?.kind === "move" && i.applicationId ? await moveKickoff(i.applicationId, kickoff) : await startOnboarding(i.engagementId, startId.current, kickoff);
      if (!r.ok) { fail(i.engagementId, r); return; }
      setForm(null);
      setOpen((s) => new Set(s).add(i.engagementId));
      router.refresh();
    });
  }
  function tick(i: OnboardingItem, s: OnboardingStep) {
    if (!i.doneStatusId) return;
    setSaid(null);
    run(async () => {
      const r = await tickStep(s.taskId, i.doneStatusId as string);
      if (!r.ok) { fail(i.engagementId, r); return; }
      router.refresh();
    });
  }
  function baseline(i: OnboardingItem) {
    setSaid(null);
    run(async () => {
      const r = await openBaselineAudit(i.engagementId);
      if (!r.ok) { fail(i.engagementId, r); return; }
      router.push(auditHref(deptId, r.auditId));
    });
  }

  if (data.items.length === 0) {
    return (
      <p className="scp-note" role="status">
        No client is being onboarded. A new client appears here while its engagement is a draft, and again whenever it has onboarding steps still open.
      </p>
    );
  }

  return (
    <div className="scp-onb">
      {data.template === null
        ? <p className="scp-note scp-note--reason" role="status">The company has not chosen an onboarding template, so nobody can be started yet. The Social Media head, the GM, the owner or the superadmin chooses one in Settings.</p>
        : <p className="scp-lede">Template: <strong>{data.template.name}</strong>. Each step is a task in the client&apos;s own project, due a number of working days after the kickoff.</p>}
      {data.items.map((i) => {
        const late = lateCount(i);
        const started = i.applicationId !== null;
        const why = started ? null : startBlockWords(i, data.canStart);
        const phases = groupByPhase(i.steps);
        const isOpen = open.has(i.engagementId);
        const id = `${uid}-${i.engagementId}`;
        return (
          <article key={i.engagementId} className="scp-onb__client" aria-label={`${i.clientName} onboarding`}>
            <div className="scp-onb__head">
              <h3 className="scp-onb__name">{i.clientName}</h3>
              <span className="scp-onb__meta">Officer: {i.officer?.name ?? "not set"}</span>
              <span className="scp-onb__meta">{started ? `Kickoff ${formatDate(i.kickoff)}` : "Kickoff not set"}</span>
              {late > 0 && <span className="scp-onb__chip scp-onb__chip--late">{late} late</span>}
              {started && i.progress.total > 0 && i.progress.done === i.progress.total && <span className="scp-onb__chip scp-onb__chip--ok">All done</span>}
            </div>

            <div className="scp-onb__progress">
              {started && <progress className="scp-onb__bar" value={i.progress.done} max={Math.max(1, i.progress.total)} aria-label={`${i.clientName}: ${progressPercent(i)} percent of the steps done`} />}
              <span>{progressText(i)}</span>
            </div>
            {started && (
              <p className="scp-onb__next">
                {i.next
                  ? <>Next: <strong>{i.next.title}</strong>{i.next.dueDate ? <>, due <span className={i.next.late ? "scp-onb__due scp-onb__due--late" : "scp-onb__due"}>{formatDate(i.next.dueDate)}{i.next.late ? " (late)" : ""}</span></> : null}</>
                  : "Every step is done."}
              </p>
            )}

            <div className="scp-onb__actions">
              {!started && (
                <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || why !== null} aria-describedby={why ? `${id}-why` : undefined} onClick={() => openForm("start", i)}>
                  Start onboarding
                </button>
              )}
              {started && (
                <>
                  <button type="button" className="lux-btn lux-btn--sm" aria-expanded={isOpen} aria-controls={`${id}-list`} onClick={() => toggle(i.engagementId)}>
                    {isOpen ? "Hide checklist" : "Show checklist"}
                  </button>
                  <button type="button" className="lux-btn lux-btn--sm" disabled={pending} onClick={() => openForm("move", i)}>Move kickoff</button>
                </>
              )}
              {i.projectId && <Link className="scp-onb__link" href={projectHref(i.projectId)}>Open the project</Link>}
              {i.baselineAudit
                ? <Link className="scp-onb__link" href={auditHref(deptId, i.baselineAudit.auditId)}>
                  Baseline audit ({i.baselineAudit.status === "final" ? `final${i.baselineAudit.overall !== null ? `, ${i.baselineAudit.overall} of 100` : ""}` : "draft"})
                </Link>
                : <button type="button" className="lux-btn lux-btn--sm" disabled={pending} onClick={() => baseline(i)}>Open baseline audit</button>}
              <Link className="scp-onb__link" href={allocationHref(deptId)}>Set the allocation</Link>
            </div>
            {why && <p id={`${id}-why`} className="scp-note scp-note--reason">{why}</p>}

            {form?.engagementId === i.engagementId && (
              <form className="scp-onb__form" aria-label={form.kind === "start" ? `Start onboarding for ${i.clientName}` : `Move the kickoff for ${i.clientName}`} onSubmit={(e) => { e.preventDefault(); submit(i); }}>
                <div className="scp-field">
                  <label htmlFor={`${id}-kickoff`}>Kickoff day</label>
                  <input id={`${id}-kickoff`} className="scp-input" type="date" value={kickoff} onChange={(e) => setKickoff(e.target.value)} required />
                </div>
                <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>{form.kind === "start" ? (pending ? "Starting…" : "Start") : (pending ? "Moving…" : "Move kickoff")}</button>
                <button type="button" className="lux-btn lux-btn--sm" onClick={() => setForm(null)}>Cancel</button>
                <span className="scp-field__hint">
                  {form.kind === "start"
                    ? "Each step is due a number of working days after this day. A kickoff on a day off counts from the next working day."
                    : "The steps not yet done are re-dated from the new day. Done steps stay where they are."}
                </span>
              </form>
            )}

            {said?.engagementId === i.engagementId && <RefusalNote refusal={{ status: 0, error: said.error }} message={said.message} />}

            {started && isOpen && (
              <div id={`${id}-list`} className="scp-onb__phases">
                {phases.map((p) => (
                  <section key={p.phase} className="scp-onb__phase" aria-label={p.title}>
                    <h4>{p.title} · {p.done} of {p.steps.length}</h4>
                    <ul className="scp-onb__steps">
                      {p.steps.map((s) => (
                        <li key={s.taskId} className={s.done ? "scp-onb__step scp-onb__step--done" : "scp-onb__step"}>
                          <input type="checkbox" checked={s.done} disabled={s.done || pending || !i.doneStatusId} aria-label={`Mark done: ${s.title}`} onChange={() => tick(i, s)} />
                          <span className="scp-onb__title">{s.title}</span>
                          <span className="scp-onb__role">{s.roleLabel}</span>
                          <span className={s.late ? "scp-onb__due scp-onb__due--late" : "scp-onb__due"}>{s.dueDate ? `Due ${formatDate(s.dueDate)}` : "No due day"}{s.late ? " · late" : ""}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
