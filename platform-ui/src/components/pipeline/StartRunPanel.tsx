"use client";
import { useActionState, useState } from "react";
import Link from "next/link";
import { createRunAction, relinkOrphanRecordingsAction } from "@/lib/pipelineActions";

type RunResult = { ok: boolean; error?: string; id?: string };
type RepairResult = { ok: boolean; error?: string; relinked?: number };

/**
 * B2 + B6 — the two run-lifecycle controls that existed only as API endpoints.
 *
 * Collapsed by default and worded as recovery, not routine: the normal path is still a recorded
 * meeting flowing through the dispatcher. Putting "start a run by hand" beside the everyday controls
 * would invite people to bypass capture, which is where the transcript, the MOM and the artifacts all
 * come from — a hand-started run has none of them.
 */
export function StartRunPanel({
  clients,
  projects,
}: {
  clients: { id: string; name: string }[];
  projects: { id: string; name: string; client_id?: string | null }[];
}) {
  const [open, setOpen] = useState(false);
  const [run, startRun, runPending] = useActionState<RunResult | null, FormData>(
    async (_p, fd) => createRunAction(fd), null);
  const [repair, doRepair, repairPending] = useActionState<RepairResult | null, FormData>(
    async () => relinkOrphanRecordingsAction(), null);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
        <p style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)", maxWidth: 620 }}>
          Runs normally start from a recorded meeting. These are for the cases that don&rsquo;t: work
          briefed by email or carried over from an earlier project, and recordings that lost their run.
        </p>
        {!open && (
          <button type="button" className="btn" onClick={() => setOpen(true)} style={{ fontSize: 13 }}>
            Recovery tools
          </button>
        )}
      </div>

      {open && (
        <>
          <form action={startRun} style={{ display: "grid", gap: 10, padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 10 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <input
                name="title"
                required
                placeholder="What is this delivery? (e.g. Nusa Coffee — phase 2)"
                style={{ flex: "1 1 240px", padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 10, font: "400 13px var(--font-body)" }}
              />
              <label style={{ display: "grid", gap: 4, flex: "1 1 190px" }}>
                <span style={{ font: "500 12px var(--font-body)", color: "var(--ink-muted)" }}>Client</span>
                {/* Required, unlike the API, which permits null. A run with no client can never appear
                    in a portal, so creating one here would silently produce invisible work. */}
                <select name="clientId" required defaultValue="" style={{ padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 10, font: "400 13px var(--font-body)" }}>
                  <option value="" disabled>Choose a client…</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label style={{ display: "grid", gap: 4, flex: "1 1 190px" }}>
                <span style={{ font: "500 12px var(--font-body)", color: "var(--ink-muted)" }}>Project (optional)</span>
                <select name="projectId" defaultValue="" style={{ padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 10, font: "400 13px var(--font-body)" }}>
                  <option value="">None</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button type="submit" className="btn" disabled={runPending} style={{ fontSize: 13 }}>
                {runPending ? "Starting…" : "Start a run without a meeting"}
              </button>
              <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
                Opens with the three tracks pending. There will be no transcript or MOM to extract from.
              </span>
            </div>
            {run && !run.ok && run.error && (
              <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{run.error}</p>
            )}
            {run?.ok && run.id && (
              <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--ink-muted)" }}>
                Started. <Link href={`/pipeline/${run.id}`} style={{ color: "var(--erp-accent)" }}>Open the run</Link>
              </p>
            )}
          </form>

          <form action={doRepair} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 10 }}>
            <button type="submit" className="btn" disabled={repairPending} style={{ fontSize: 13 }}>
              {repairPending ? "Repairing…" : "Relink orphaned recordings"}
            </button>
            <span style={{ font: "400 12px/1.45 var(--font-body)", color: "var(--ink-subtle)", flex: "1 1 260px" }}>
              Reconnects recordings whose run exists but was never linked back to them. Safe to run
              repeatedly — it only touches recordings that are still missing a run.
            </span>
            {repair && !repair.ok && repair.error && (
              <span style={{ font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{repair.error}</span>
            )}
            {/* Zero is a real, useful answer here — "nothing was broken" — so it is reported rather
                than rendered as a silent success. */}
            {repair?.ok && (
              <span style={{ font: "500 13px var(--font-body)", color: "var(--ink-muted)" }}>
                {repair.relinked === 0 ? "Nothing to repair." : `Relinked ${repair.relinked}.`}
              </span>
            )}
          </form>
        </>
      )}
    </div>
  );
}
