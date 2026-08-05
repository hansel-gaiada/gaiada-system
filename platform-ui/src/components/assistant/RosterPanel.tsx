"use client";
import { useCallback, useEffect, useState } from "react";
import {
  handoffStatusLabel, hasActiveHandoff, type AssistantHandoff, type RosterAgent, type RosterEpisode,
} from "@/lib/assistant";
import {
  createHandoffAction, getHandoffTranscriptAction, refreshHandoffsAction, refreshRosterAction,
} from "@/lib/assistantActions";
import type { AgentRun } from "@/lib/admin";

// ASST-21 — the roster right-rail panel: the REAL specialist registry (never a hardcoded mirror —
// see `handoffs.ts`'s `fetchRoster` header), a "hand off this thread" form, THIS thread's own
// handoffs (the run-watch view — polls while any handoff is still in flight), and THIS caller's
// episodic run history. Same right-rail family as MemoryPanel/CapabilitiesPanel (blueprint §8's
// collapsible "context inspector"), so it reuses the SAME `.asst-mem` shell classes; only the
// roster/handoff-specific bits (`asst-roster__*`) are new (see assistant.css).
//
// ── WHY A TRANSCRIPT IS LAZY, NEVER AUTO-LOADED FOR EVERY ROW ──────────────────────────────────────
// `getHandoffTranscriptAction` calls the SAME `GET :t/agents/runs/:runId` the Intelligence console
// already uses (`lib/admin.ts`'s `getAgentRun`) — now additionally readable by the handoff's own
// owner (resource_agent_run.yaml's additive rule), not just an elevated admin. A transcript can be
// long, so it is fetched only when the user opens that ONE row, not for every handoff on load.
const POLL_MS = 4000;

export function RosterPanel({ activeThreadId, onClose }: { activeThreadId: string | null; onClose: () => void }) {
  const [agents, setAgents] = useState<RosterAgent[]>([]);
  const [supervisorName, setSupervisorName] = useState<string | null>(null);
  const [runnerConfigured, setRunnerConfigured] = useState(true);
  const [episodicHistory, setEpisodicHistory] = useState<RosterEpisode[]>([]);
  const [handoffs, setHandoffs] = useState<AssistantHandoff[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [goalDraft, setGoalDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Record<string, AgentRun | null>>({});
  const [transcriptLoading, setTranscriptLoading] = useState<string | null>(null);

  const loadRoster = useCallback(async () => {
    const r = await refreshRosterAction();
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    setAgents(r.agents);
    setSupervisorName(r.supervisor?.name ?? null);
    setRunnerConfigured(r.runnerConfigured);
    setEpisodicHistory(r.episodicHistory);
    setSelectedAgent((cur) => cur || r.agents[0]?.name || "");
  }, []);

  const loadHandoffs = useCallback(async (threadId: string) => {
    const r = await refreshHandoffsAction(threadId);
    if (r.ok) setHandoffs(r.items);
  }, []);

  useEffect(() => {
    setLoading(true);
    void loadRoster().finally(() => setLoading(false));
  }, [loadRoster]);

  useEffect(() => {
    if (!activeThreadId) {
      setHandoffs([]);
      return;
    }
    void loadHandoffs(activeThreadId);
  }, [activeThreadId, loadHandoffs]);

  // The run-watch view's own refresh: keep polling while ANY handoff on this thread is still in
  // flight (queued/running/suspended-and-not-yet-resolved counts as "not terminal" — see
  // `hasActiveHandoff`); stop the instant every handoff is terminal, and never poll with no active
  // thread at all.
  useEffect(() => {
    if (!activeThreadId || !hasActiveHandoff(handoffs)) return;
    const t = setInterval(() => void loadHandoffs(activeThreadId), POLL_MS);
    return () => clearInterval(t);
  }, [activeThreadId, handoffs, loadHandoffs]);

  async function handleHandoff(e: React.FormEvent) {
    e.preventDefault();
    if (!activeThreadId) {
      setError("Select or start a chat first.");
      return;
    }
    const goal = goalDraft.trim();
    if (!goal || !selectedAgent) return;
    setSubmitting(true);
    const r = await createHandoffAction(activeThreadId, selectedAgent, goal);
    setSubmitting(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    setGoalDraft("");
    await loadHandoffs(activeThreadId);
  }

  async function handleViewTranscript(h: AssistantHandoff) {
    const runId = h.runId;
    if (!runId) return;
    setOpenRunId((cur) => (cur === runId ? null : runId));
    if (Object.prototype.hasOwnProperty.call(transcripts, runId)) return;
    setTranscriptLoading(runId);
    const r = await getHandoffTranscriptAction(runId);
    setTranscriptLoading(null);
    if (r.ok) setTranscripts((prev) => ({ ...prev, [runId]: r.run }));
  }

  return (
    <aside id="asst-roster-panel" className="asst-mem" aria-label="Assistant agent roster">
      <div className="asst-mem__head">
        <p className="type-eyebrow" style={{ color: "var(--erp-accent)" }}>Agents</p>
        <button type="button" className="asst-mem__close" aria-label="Close roster panel" onClick={onClose}>
          <span aria-hidden="true">&times;</span>
        </button>
      </div>

      {error && <p className="asst-mem__error" role="alert">{error}</p>}

      <div className="asst-mem__list">
        {loading ? (
          <p className="asst-mem__empty">Loading the roster…</p>
        ) : !runnerConfigured ? (
          <p className="asst-mem__empty">The agent runtime isn&rsquo;t reachable right now.</p>
        ) : (
          <>
            <section aria-label="Hand off this thread">
              <h2 className="asst-mem__group-label">Hand off to a specialist</h2>
              <p className="asst-mem__group-hint">
                Send a longer task to a specialist and watch it run — the reply lands here when it&rsquo;s done.
              </p>
              <form className="asst-roster__handoff" onSubmit={handleHandoff}>
                <label htmlFor="asst-roster-agent" className="asst-sr-only">Specialist</label>
                <select
                  id="asst-roster-agent"
                  className="asst-mem__scope-select"
                  value={selectedAgent}
                  onChange={(e) => setSelectedAgent(e.target.value)}
                  disabled={agents.length === 0}
                >
                  {agents.map((a) => (
                    <option key={a.name} value={a.name}>{a.name}{a.writeCapable ? " (write)" : ""}</option>
                  ))}
                </select>
                <label htmlFor="asst-roster-goal" className="asst-sr-only">Task for the specialist</label>
                <textarea
                  id="asst-roster-goal"
                  className="asst-mem__propose-input"
                  placeholder="Describe the longer task to hand off…"
                  value={goalDraft}
                  onChange={(e) => setGoalDraft(e.target.value)}
                />
                <button
                  type="submit"
                  className="lux-btn lux-btn--solid lux-btn--sm"
                  disabled={submitting || !goalDraft.trim() || !selectedAgent || !activeThreadId}
                >
                  Hand off
                </button>
                {!activeThreadId && <p className="asst-mem__group-hint">Select or start a chat first.</p>}
              </form>
            </section>

            {activeThreadId && (
              <section aria-label="This thread's handoffs">
                <h2 className="asst-mem__group-label">This thread&rsquo;s handoffs</h2>
                {handoffs.length === 0 ? (
                  <p className="asst-mem__empty">No handoffs yet.</p>
                ) : (
                  <ul>
                    {handoffs.map((h) => {
                      const runId = h.runId; // narrowed once, reused below — h.runId is `string | null`
                      return (
                        <li key={h.id} className="asst-mem__row">
                          <p className="asst-mem__content">{h.agent} — {h.goalText}</p>
                          <div className="asst-mem__row-meta">
                            <span className="asst-roster__status-chip" data-status={h.status}>{handoffStatusLabel(h.status)}</span>
                            {runId && (
                              <button type="button" className="asst-mem__action" onClick={() => handleViewTranscript(h)}>
                                {openRunId === runId ? "Hide" : "View"} transcript
                              </button>
                            )}
                          </div>
                          {runId && openRunId === runId && (
                            <div className="asst-roster__transcript">
                              {transcriptLoading === runId ? (
                                <p className="asst-mem__empty">Loading transcript…</p>
                              ) : transcripts[runId] ? (
                                <ol>
                                  {(transcripts[runId]?.steps ?? []).map((s: { kind: string; detail: string }, i: number) => (
                                    <li key={i}>{s.kind}: {s.detail}</li>
                                  ))}
                                </ol>
                              ) : (
                                <p className="asst-mem__empty">Transcript not available.</p>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            )}

            <section aria-label="Registry">
              <h2 className="asst-mem__group-label">Roster</h2>
              <ul>
                {agents.map((a) => (
                  <li key={a.name} className="asst-mem__row">
                    <p className="asst-mem__content">{a.name}</p>
                    <p className="asst-mem__group-hint">
                      {a.tools.length > 0 ? a.tools.join(", ") : "no tools"}
                      {a.writeCapable ? " · write-capable" : ""}
                    </p>
                  </li>
                ))}
                {supervisorName && (
                  <li className="asst-mem__row">
                    <p className="asst-mem__content">{supervisorName} <span className="asst-mem__group-hint">(supervisor)</span></p>
                  </li>
                )}
              </ul>
            </section>

            <section aria-label="Episodic history">
              <h2 className="asst-mem__group-label">Recent runs</h2>
              {episodicHistory.length === 0 ? (
                <p className="asst-mem__empty">No run history yet.</p>
              ) : (
                <ul>
                  {episodicHistory.slice(0, 20).map((ep) => (
                    <li key={ep.runId} className="asst-mem__row">
                      <p className="asst-mem__content">{ep.agent} — {handoffStatusLabel(ep.status)}</p>
                      <p className="asst-mem__group-hint">{ep.outcome ?? "(no outcome recorded)"}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
