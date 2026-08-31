"use client";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState } from "react";
import type { BriefingResult } from "@/lib/prdActions";
import "./prd-studio.css";

// Step 1 — create the briefing as an item FIRST. Nothing records here.
//
// A briefing (meeting recording) knows its client and its project — nothing else — and this tab is
// Web Dev's, so the project is what makes a briefing Web Dev's. In practice the project does not
// exist yet when the call happens: it is born WITH the briefing. So the default is "New project",
// named after the briefing, for this client, in this department; "Link an existing project" is the
// optional alternative for a follow-up call on work that already has one. The action
// (`createBriefingAction`) does both writes. Client is required because the client sign-off beat
// (step 4) needs a client on the run. Medium is chosen now because the browser recorder must know
// which devices to ask for before the take starts.
export interface ComposerClient { id: string; name: string }
export interface ComposerProject { id: string; name: string; client_id: string | null }

export function BriefingComposer({
  clients,
  projects,
  departmentId,
  departmentName = "this department",
  action,
  fixed,
}: {
  clients: ComposerClient[];
  /** This department's projects only — offered in "Link an existing project" mode. */
  projects: ComposerProject[];
  departmentId?: string;
  departmentName?: string;
  action: (prev: BriefingResult | null, formData: FormData) => Promise<BriefingResult>;
  /** Inside a project workspace the lineage is already known: no client/project questions, the
   *  briefing is filed under this project (projectMode "existing"). */
  fixed?: { clientId: string | null; clientName: string | null; projectId: string; projectName: string };
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<BriefingResult | null, FormData>(action, null);
  const [title, setTitle] = useState("");
  const [clientId, setClientId] = useState("");
  const [kind, setKind] = useState<"audio" | "video">("audio");
  const [projectMode, setProjectMode] = useState<"new" | "existing">("new");
  const [formKey, setFormKey] = useState(0);

  const clientProjects = useMemo(
    () => (clientId ? projects.filter((p) => p.client_id === clientId) : []),
    [projects, clientId],
  );
  const clientLabel = clients.find((c) => c.id === clientId)?.name ?? "this client";
  const linkBlocked = projectMode === "existing" && !!clientId && clientProjects.length === 0;

  // On success: re-read the page so the new briefing card appears, and clear the form for the next
  // one. The confirmation stays visible — it is the hand-off to step 2.
  useEffect(() => {
    if (state?.ok) {
      setTitle("");
      setClientId("");
      setKind("audio");
      setProjectMode("new");
      setFormKey((k) => k + 1);
      router.refresh();
    }
  }, [state, router]);

  return (
    <form key={formKey} action={formAction} className="prd-composer">
      {departmentId && <input type="hidden" name="departmentId" value={departmentId} />}
      {fixed ? (
        <>
          <input type="hidden" name="clientId" value={fixed.clientId ?? ""} />
          <input type="hidden" name="projectMode" value="existing" />
          <input type="hidden" name="projectId" value={fixed.projectId} />
          <label className="prd-field">
            What is this briefing about?
            <input name="title" required placeholder="e.g. Sprint 3 review with the client" autoComplete="off" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <p className="prd-hint">Filed under {fixed.projectName}{fixed.clientName ? ` · ${fixed.clientName}` : ""}.</p>
        </>
      ) : (
      <div className="prd-fields prd-fields--two">
        <label className="prd-field">
          What is this briefing about?
          <input name="title" required placeholder="e.g. Northwind — checkout flow intake" autoComplete="off" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="prd-field">
          Client
          <select name="clientId" required value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">Choose…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>
      )}

      {!fixed && (
      <div className="prd-field" style={{ display: "grid", gap: 6 }}>
        <span id="prd-project-label">Project</span>
        <div className="prd-segment" role="radiogroup" aria-labelledby="prd-project-label">
          <button type="button" role="radio" aria-checked={projectMode === "new"} className="prd-segment__opt" onClick={() => setProjectMode("new")}>New project</button>
          <button type="button" role="radio" aria-checked={projectMode === "existing"} className="prd-segment__opt" onClick={() => setProjectMode("existing")}>Link an existing project</button>
        </div>
        <input type="hidden" name="projectMode" value={projectMode} />
        {projectMode === "new" ? (
          <p className="prd-hint">
            A {departmentName} project {title.trim() ? <>“{title.trim()}”</> : "named after this briefing"} is created for {clientId ? clientLabel : "the client"} together with the briefing.
          </p>
        ) : (
          <>
            <label className="prd-field" style={{ maxWidth: 420 }}>
              <span className="prd-field__optional">Which project?</span>
              <select name="projectId" required={projectMode === "existing"} defaultValue="" disabled={!clientId || linkBlocked} aria-label="Project">
                <option value="">{!clientId ? "Choose a client first" : linkBlocked ? "No project here" : "Choose…"}</option>
                {clientProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            {linkBlocked && (
              <p className="prd-note">No {departmentName} project for {clientLabel} yet. Switch to “New project” and one is created with the briefing.</p>
            )}
          </>
        )}
      </div>
      )}

      <div className="prd-field" style={{ display: "grid", gap: 6 }}>
        <span id="prd-kind-label">You will record</span>
        <div className="prd-segment" role="radiogroup" aria-labelledby="prd-kind-label">
          <button type="button" role="radio" aria-checked={kind === "audio"} className="prd-segment__opt" onClick={() => setKind("audio")}>Audio</button>
          <button type="button" role="radio" aria-checked={kind === "video"} className="prd-segment__opt" onClick={() => setKind("video")}>Audio + video</button>
        </div>
        <input type="hidden" name="kind" value={kind} />
      </div>

      <div className="prd-composer__foot">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--md" disabled={pending || linkBlocked}>
          {pending ? "Creating…" : "Create briefing"}
        </button>
        {state?.ok ? (
          <p className="prd-note prd-note--ok">
            Briefing created{state.projectCreated ? " with its project" : ""} — add its recording below.
          </p>
        ) : state?.error ? (
          <p className="prd-note prd-note--error">{state.error}</p>
        ) : (
          <p className="prd-hint">Nothing records yet. Once the briefing exists, you choose how to add the recording.</p>
        )}
      </div>
    </form>
  );
}
