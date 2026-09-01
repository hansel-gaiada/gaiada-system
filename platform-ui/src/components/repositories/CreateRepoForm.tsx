"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FRAMEWORKS, FRAMEWORK_LABEL, FRAMEWORK_UNAVAILABLE, DEFAULT_FRAMEWORK, isValidSlugInput, type SiteFramework } from "@/lib/webdevProvisionedSites";
import type { SiteActionResult } from "@/lib/webdevProvisionedSitesActions";
import { suggestSlug, type EligibleRun } from "@/lib/repoInventory";
import "./repositories.css";

// "Create repository" = ask the provisioning service for a site: it creates the GitHub repo and a
// staging site together. Two ways, same endpoint (`POST /modules/webdev/provision`):
//   • Standalone (default) — just a name and a framework. Off-pipeline on the backend
//     (`pipeline_run_id: null`), so it carries no client or project; the table says so.
//   • For a PRD run — the run brings the client and project with it and the repo shows in its lineage.
// Direct GitHub creation outside provisioning is fail-closed on the backend by design (WS11); this is
// the sanctioned manual path. The new row lands in the table as Provisioning and moves on its own.
export interface CreateRepoFormActions {
  provision: (formData: FormData) => Promise<SiteActionResult>;
}

export interface LineageClient { id: string; name: string }
export interface LineageProject { id: string; name: string; client_id: string | null }

export function CreateRepoForm({ runs, clients = [], projects = [], actions, prdHref, onCreated }: {
  runs: EligibleRun[];
  /** Optional lineage for a standalone repo (platform-nest 0.45.0 stores it on the site). */
  clients?: LineageClient[];
  projects?: LineageProject[];
  actions: CreateRepoFormActions;
  prdHref: string;
  onCreated?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"standalone" | "run">("standalone");
  const [runId, setRunId] = useState("");
  const [framework, setFramework] = useState<SiteFramework>(DEFAULT_FRAMEWORK);
  const [slug, setSlug] = useState("");
  const [clientId, setClientId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [result, setResult] = useState<SiteActionResult | null>(null);
  const clientProjects = clientId ? projects.filter((p) => p.client_id === clientId) : [];

  const slugTrim = slug.trim();
  const slugOk = slugTrim === "" || isValidSlugInput(slugTrim);
  const chosen = runs.find((r) => r.id === runId) ?? null;
  const canSubmit = !pending && slugOk && (mode === "standalone" ? slugTrim !== "" : !!runId);

  const pickRun = (id: string) => {
    setRunId(id);
    setResult(null);
    const run = runs.find((r) => r.id === id);
    setSlug(run ? suggestSlug(run.title) : "");
  };

  const submit = () => {
    if (!canSubmit) return;
    setResult(null);
    startTransition(async () => {
      const fd = new FormData();
      if (mode === "run") fd.set("runId", runId);
      if (mode === "standalone" && clientId) fd.set("clientId", clientId);
      if (mode === "standalone" && projectId) fd.set("projectId", projectId);
      fd.set("framework", framework);
      if (slugTrim) fd.set("slug", slugTrim);
      const r = await actions.provision(fd);
      setResult(r);
      if (r.ok) { router.refresh(); onCreated?.(); }
    });
  };

  const switchMode = (m: "standalone" | "run") => { setMode(m); setResult(null); if (m === "standalone") { setRunId(""); } else { setClientId(""); setProjectId(""); } setSlug(""); };

  return (
    <div className="repo-create">
      <div className="repo-create__mode" role="radiogroup" aria-label="What is this repository for?">
        <button type="button" role="radio" aria-checked={mode === "standalone"} className="prd-segment__opt repo-create__opt" onClick={() => switchMode("standalone")}>Standalone</button>
        <button type="button" role="radio" aria-checked={mode === "run"} className="prd-segment__opt repo-create__opt" onClick={() => switchMode("run")}>For a PRD run</button>
      </div>
      <p className="repo-note">
        {mode === "standalone"
          ? "The provisioning service creates the GitHub repository and a staging site under this name. Client and project are optional — set them so the repo shows whose it is."
          : "The GitHub repository and staging site are created for a PRD run; the run brings the client and project with it."}
      </p>
      {mode === "run" && runs.length === 0 && (
        <p className="repo-note">
          Every PRD run in this department already has a repository, or there are no runs yet — <Link href={prdHref}>start one in PRD Studio →</Link>, or create a standalone repository instead.
        </p>
      )}
      <div className="repo-create__fields">
        {mode === "run" && (
          <label className="repo-field">
            PRD run
            <select value={runId} onChange={(e) => pickRun(e.target.value)} disabled={pending || runs.length === 0} required>
              <option value="">Choose a run…</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}{r.clientName ? ` · ${r.clientName}` : ""}{r.retry ? " (previous attempt failed)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="repo-field">
          Framework
          <select value={framework} onChange={(e) => setFramework(e.target.value as SiteFramework)} disabled={pending}>
            {FRAMEWORKS.map((f) => (
              // An unavailable kind is rendered DISABLED with its reason, never omitted. Omitting
              // WordPress read as "not supported", which is what caused the confusion this change
              // came from — the backend supports it; one last-mile provider does not yet.
              <option key={f} value={f} disabled={!!FRAMEWORK_UNAVAILABLE[f]}>
                {FRAMEWORK_LABEL[f]}{FRAMEWORK_UNAVAILABLE[f] ? " — not yet available" : ""}
              </option>
            ))}
          </select>
          {FRAMEWORK_UNAVAILABLE[framework] && (
            <span className="repo-field__hint">{FRAMEWORK_UNAVAILABLE[framework]}</span>
          )}
        </label>
        {mode === "standalone" && (
          <>
            <label className="repo-field">
              Client
              <select value={clientId} onChange={(e) => { setClientId(e.target.value); setProjectId(""); }} disabled={pending}>
                <option value="">None</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="repo-field">
              Project
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={pending || !clientId}>
                <option value="">{clientId ? "None" : "Choose a client first"}</option>
                {clientProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </>
        )}
        <label className="repo-field">
          Repository name
          <input
            type="text"
            value={slug}
            onChange={(e) => { setSlug(e.target.value); setResult(null); }}
            disabled={pending || (mode === "run" && !runId)}
            placeholder={mode === "run" && !runId ? "Choose a run first" : "my-project-name"}
            aria-invalid={!slugOk}
          />
        </label>
      </div>
      {!slugOk && <p className="repo-note repo-note--error">Use lowercase letters, digits and hyphens only (1–40 characters).</p>}
      <div className="repo-create__foot">
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={submit} disabled={!canSubmit}>
          {pending ? "Creating…" : "Create repository"}
        </button>
        {chosen?.retry && <span className="repo-note">The previous attempt for this run failed — pick a different name if that was the reason.</span>}
        {result && !result.ok && <p role="alert" className="repo-note repo-note--error">{result.error}</p>}
        {result?.ok && (
          <p role="status" className="repo-note repo-note--ok">
            Started — <strong>{result.site.slug}</strong> is being provisioned. It appears in the table as Provisioning and moves on its own; "Check status now" re-polls it.
          </p>
        )}
      </div>
    </div>
  );
}
