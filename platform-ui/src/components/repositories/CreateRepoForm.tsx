"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FRAMEWORKS, FRAMEWORK_LABEL, DEFAULT_FRAMEWORK, isValidSlugInput, type SiteFramework } from "@/lib/webdevProvisionedSites";
import type { SiteActionResult } from "@/lib/webdevProvisionedSitesActions";
import { suggestSlug, type EligibleRun } from "@/lib/repoInventory";
import "./repositories.css";

// "Create repository" = provision a site for a PRD run. The GitHub repo and the staging site are
// created together by the provisioning service; the run is what carries the client and project, so
// the form asks for a RUN, a framework and a name — never a bare GitHub name (direct repo creation is
// fail-closed on the backend by design). Submits through the same `provisionSiteAction` the run
// workspace uses; the new row lands in the table as Provisioning and moves on its own.
export interface CreateRepoFormActions {
  provision: (formData: FormData) => Promise<SiteActionResult>;
}

export function CreateRepoForm({ runs, actions, prdHref, onCreated }: {
  runs: EligibleRun[];
  actions: CreateRepoFormActions;
  prdHref: string;
  onCreated?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [runId, setRunId] = useState("");
  const [framework, setFramework] = useState<SiteFramework>(DEFAULT_FRAMEWORK);
  const [slug, setSlug] = useState("");
  const [result, setResult] = useState<SiteActionResult | null>(null);

  if (runs.length === 0) {
    return (
      <div className="repo-create">
        <p className="repo-note">
          Every PRD run in this department already has a repository, or there are no runs yet. Repositories are created from PRD runs —{" "}
          <Link href={prdHref}>start one in PRD Studio →</Link>
        </p>
      </div>
    );
  }

  const slugOk = slug.trim() === "" || isValidSlugInput(slug.trim());
  const chosen = runs.find((r) => r.id === runId) ?? null;
  const canSubmit = !!runId && slugOk && !pending;

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
      fd.set("runId", runId);
      fd.set("framework", framework);
      if (slug.trim()) fd.set("slug", slug.trim());
      const r = await actions.provision(fd);
      setResult(r);
      if (r.ok) { router.refresh(); onCreated?.(); }
    });
  };

  return (
    <div className="repo-create">
      <p className="repo-note">
        A repository is created for a PRD run: the provisioning service creates the GitHub repo and a staging site together, and the run brings the client and project with it.
      </p>
      <div className="repo-create__fields">
        <label className="repo-field">
          PRD run
          <select value={runId} onChange={(e) => pickRun(e.target.value)} disabled={pending} required>
            <option value="">Choose a run…</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}{r.clientName ? ` · ${r.clientName}` : ""}{r.retry ? " (previous attempt failed)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="repo-field">
          Framework
          <select value={framework} onChange={(e) => setFramework(e.target.value as SiteFramework)} disabled={pending}>
            {FRAMEWORKS.map((f) => <option key={f} value={f}>{FRAMEWORK_LABEL[f]}</option>)}
          </select>
        </label>
        <label className="repo-field">
          Repository name
          <input
            type="text"
            value={slug}
            onChange={(e) => { setSlug(e.target.value); setResult(null); }}
            disabled={pending || !runId}
            placeholder={runId ? "my-project-name" : "Choose a run first"}
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
