"use client";
// PRV-04 — the run workspace's "Site & repo" card (design docs/blueprints/provision-erp-seam-design.md
// §06). Mirrors ChangeRequestsPanel.tsx's shape (a "use client" panel taking server actions as props,
// `useTransition` + local state for the inline result banner) rather than page.tsx's plain
// fire-and-forget `<form action={...}>` forms: unlike every OTHER action on that page, a provision
// attempt can fail BEFORE any row exists at all (invalid slug, unsupported stack, a run that isn't
// ready) — with no row, there is nothing for a page reload to show, so this is the one place on the
// run workspace where the immediate result has to be rendered directly rather than left to the next
// GET. Every action still ALSO revalidates the page (webdevProvisionedSitesActions.ts), so the row
// list below stays the authoritative source of truth for anything that DID get recorded.
import { useState, useTransition } from "react";
import { Card, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { formatDateTime } from "@/lib/format";
import {
  STATUS_LABEL, FRAMEWORKS, FRAMEWORK_LABEL, DEFAULT_FRAMEWORK,
  canReconcile, canStartNewProvision, failureCopy,
  type ProvisionedSite, type SiteFramework, FRAMEWORK_UNAVAILABLE,
} from "@/lib/webdevProvisionedSites";
import type { SiteActionResult } from "@/lib/webdevProvisionedSitesActions";
import "./pipeline.css";

export interface SiteRepoCardActions {
  provision: (formData: FormData) => Promise<SiteActionResult>;
  reconcile: (formData: FormData) => Promise<SiteActionResult>;
}

export type SiteListState =
  | { kind: "ok"; sites: ProvisionedSite[] }
  | { kind: "not_enabled" }
  | { kind: "refused" };

export function SiteRepoCard({
  runId, list, mayProvision, actions,
}: {
  runId: string;
  list: SiteListState;
  mayProvision: boolean;
  actions: SiteRepoCardActions;
}) {
  if (list.kind === "not_enabled") {
    return (
      <Card title="Site & repo">
        <EmptyNote>Site &amp; repo provisioning isn&apos;t turned on for this company yet.</EmptyNote>
      </Card>
    );
  }
  // A REAL refusal (Cerbos denied the read) — deliberately NOT rendered as EmptyNote, which would
  // read as "nothing has been provisioned" when the true answer might be the opposite. Same
  // distinction this page already draws for a refused project read (see page.tsx's `projectRefused`).
  if (list.kind === "refused") {
    return (
      <Card title="Site & repo">
        <p className="pl-site__refused">
          You don&apos;t have access to view this run&apos;s provisioned site (ask an admin if you need it).
        </p>
      </Card>
    );
  }

  const { sites } = list;
  const showForm = mayProvision && canStartNewProvision(sites);

  return (
    <Card title="Site & repo">
      {sites.length === 0 ? (
        <EmptyNote>No site has been provisioned for this run yet.</EmptyNote>
      ) : (
        <div className="pl-site-list">
          {sites.map((s) => (
            <SiteRow key={s.id} site={s} runId={runId} mayReconcile={mayProvision} onReconcile={actions.reconcile} />
          ))}
        </div>
      )}
      {showForm && <ProvisionForm runId={runId} retry={sites.length > 0} onProvision={actions.provision} />}
      {!mayProvision && sites.length === 0 && (
        <p className="pl-site__hint">Provisioning a site requires manager-tier access.</p>
      )}
    </Card>
  );
}

function SiteRow({ site, runId, mayReconcile, onReconcile }: {
  site: ProvisionedSite;
  runId: string;
  mayReconcile: boolean;
  onReconcile: (formData: FormData) => Promise<SiteActionResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SiteActionResult | null>(null);
  const reconcilable = mayReconcile && canReconcile(site);
  const failure = site.status === "failed" ? failureCopy(site.failureReason) : null;
  const frameworkLabel = FRAMEWORK_LABEL[site.framework] ?? site.framework;

  const reconcile = () => {
    setResult(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("siteId", site.id);
      fd.set("runId", runId);
      setResult(await onReconcile(fd));
    });
  };

  return (
    <div className="pl-site-row">
      <div className="pl-site-row__head">
        <StatusBadge label={site.status} />
        <span className="pl-site-row__slug">{site.slug}</span>
        <span className="pl-site-row__framework">{frameworkLabel}</span>
      </div>
      <div className="pl-site-row__links">
        <span>
          Repo:{" "}
          {site.repoUrl ? (
            <a href={site.repoUrl} target="_blank" rel="noreferrer">{site.repoUrl.replace(/^https?:\/\//, "")}</a>
          ) : (
            <em>not available yet</em>
          )}
        </span>
        <span>
          Staging:{" "}
          {site.stagingUrl ? (
            <a href={site.stagingUrl} target="_blank" rel="noreferrer">{site.stagingUrl.replace(/^https?:\/\//, "")}</a>
          ) : (
            <em>not available yet</em>
          )}
        </span>
      </div>
      <p className="pl-site-row__meta">
        Requested {formatDateTime(site.createdAt)}
        {site.approvalId ? " · via an approved automation request" : ""}
        {site.lastReconciledAt ? ` · last checked ${formatDateTime(site.lastReconciledAt)}` : ""}
      </p>
      {failure && (
        <div className="pl-site-row__failure">
          <strong>{failure.title}.</strong> {failure.body}
        </div>
      )}
      {reconcilable && (
        <button type="button" className="btn" onClick={reconcile} disabled={pending} style={{ fontSize: 13 }}>
          {pending ? "Checking…" : "Check status now"}
        </button>
      )}
      {result && !result.ok && <p role="alert" className="pl-site-row__error">{result.error}</p>}
      {result && result.ok && (
        <p role="status" className="pl-site-row__ok">Now {STATUS_LABEL[result.site.status].toLowerCase()}.</p>
      )}
    </div>
  );
}

function ProvisionForm({ runId, retry, onProvision }: {
  runId: string;
  retry: boolean;
  onProvision: (formData: FormData) => Promise<SiteActionResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [framework, setFramework] = useState<SiteFramework>(DEFAULT_FRAMEWORK);
  const [slug, setSlug] = useState("");
  const [result, setResult] = useState<SiteActionResult | null>(null);

  const submit = () => {
    setResult(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("runId", runId);
      fd.set("framework", framework);
      if (slug.trim()) fd.set("slug", slug.trim());
      const r = await onProvision(fd);
      setResult(r);
      if (r.ok) setSlug("");
    });
  };

  return (
    <div className="pl-site-form">
      <Eyebrow style={{ display: "block", marginBottom: 8 }}>
        {retry ? "Try again with a different name" : "Provision a site"}
      </Eyebrow>
      <label className="pl-site-form__field">
        <span>Framework</span>
        <select
          value={framework}
          onChange={(e) => setFramework(e.target.value as SiteFramework)}
          disabled={pending}
        >
          {/* Same rule as the repositories CreateRepoForm: an unavailable kind is DISABLED with its
              reason, never omitted — omitting WordPress read as "not supported", which is false. */}
          {FRAMEWORKS.map((f) => (
            <option key={f} value={f} disabled={!!FRAMEWORK_UNAVAILABLE[f]}>
              {FRAMEWORK_LABEL[f]}{FRAMEWORK_UNAVAILABLE[f] ? " — not yet available" : ""}
            </option>
          ))}
        </select>
        {FRAMEWORK_UNAVAILABLE[framework] && (
          <span className="pl-site-form__hint">{FRAMEWORK_UNAVAILABLE[framework]}</span>
        )}
      </label>
      <label className="pl-site-form__field">
        <span>Slug {retry ? "(required — pick a new name)" : "(optional — derived from the run title if left blank)"}</span>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          disabled={pending}
          placeholder="my-project-name"
        />
      </label>
      <button type="button" className="btn btn-primary" onClick={submit} disabled={pending} style={{ alignSelf: "flex-start" }}>
        {pending ? "Provisioning…" : "Provision"}
      </button>
      {result && !result.ok && <p role="alert" className="pl-site-form__error">{result.error}</p>}
      {result && result.ok && (
        <p role="status" className="pl-site-form__ok">
          Started — {STATUS_LABEL[result.site.status].toLowerCase()}.
        </p>
      )}
    </div>
  );
}
