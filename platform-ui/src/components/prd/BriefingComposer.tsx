"use client";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState } from "react";
import type { MeetingResult } from "@/lib/meetingsActions";
import "./prd-studio.css";

// Step 1 — create the briefing as an item FIRST. Nothing records here: this only registers the
// meeting (`startRecordingAction` → POST /meetings/recordings/start), which mints the stable
// meeting id the capture methods attach to. Client is required because the client sign-off beat
// (step 4) needs a client on the run, and `createRun` derives it from this meeting. Medium is chosen
// now because the backend stores `kind` on the row and the browser recorder must know which devices
// to ask for before the take starts.
export interface ComposerClient { id: string; name: string }
export interface ComposerProject { id: string; name: string; client_id: string | null }

export function BriefingComposer({
  clients,
  projects,
  action,
}: {
  clients: ComposerClient[];
  projects: ComposerProject[];
  action: (prev: MeetingResult | null, formData: FormData) => Promise<MeetingResult>;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<MeetingResult | null, FormData>(action, null);
  const [clientId, setClientId] = useState("");
  const [kind, setKind] = useState<"audio" | "video">("audio");
  const [formKey, setFormKey] = useState(0);

  const clientProjects = useMemo(
    () => (clientId ? projects.filter((p) => p.client_id === clientId) : []),
    [projects, clientId],
  );

  // On success: re-read the page so the new briefing card appears, and clear the form for the next
  // one. The confirmation stays visible — it is the hand-off to step 2.
  useEffect(() => {
    if (state?.ok) {
      setClientId("");
      setKind("audio");
      setFormKey((k) => k + 1);
      router.refresh();
    }
  }, [state, router]);

  return (
    <form key={formKey} action={formAction} className="prd-composer">
      <div className="prd-fields">
        <label className="prd-field">
          What is this briefing about?
          <input name="title" required placeholder="e.g. Cedar Group — intake call" autoComplete="off" />
        </label>
        <label className="prd-field">
          Client
          <select name="clientId" required value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">Choose…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="prd-field">
          <span>Project <span className="prd-field__optional">(optional)</span></span>
          <select name="projectId" defaultValue="" disabled={!clientId}>
            <option value="">{clientId ? "None" : "Choose a client first"}</option>
            {clientProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>

      <div className="prd-field" style={{ display: "grid", gap: 6 }}>
        <span id="prd-kind-label">You will record</span>
        <div className="prd-segment" role="radiogroup" aria-labelledby="prd-kind-label">
          <button type="button" role="radio" aria-checked={kind === "audio"} className="prd-segment__opt" onClick={() => setKind("audio")}>Audio</button>
          <button type="button" role="radio" aria-checked={kind === "video"} className="prd-segment__opt" onClick={() => setKind("video")}>Audio + video</button>
        </div>
        <input type="hidden" name="kind" value={kind} />
      </div>

      <div className="prd-composer__foot">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--md" disabled={pending}>
          {pending ? "Creating…" : "Create briefing"}
        </button>
        {state?.ok ? (
          <p className="prd-note prd-note--ok">Briefing created — add its recording below.</p>
        ) : state?.error ? (
          <p className="prd-note prd-note--error">{state.error}</p>
        ) : (
          <p className="prd-hint">Nothing records yet. Once the briefing exists, you choose how to add the recording.</p>
        )}
      </div>
    </form>
  );
}
