"use client";
import { useState, type ReactNode } from "react";
import {
  registry,
  parseSectionRoute,
  findSection,
  parentOf,
  activeDepts,
  type CentreProfile,
  type CentrePatch,
  type ConnectionEntry,
} from "@/lib/clientCentre";
import { useCentreAutosave, type CentreActionResult } from "./useCentreAutosave";
import { SectionTree } from "./SectionTree";
import { HomeView } from "./HomeView";
import { CompanySettingsView } from "./CompanySettingsView";
import { SectionOverviewView } from "./SectionOverviewView";
import { SectionSettingsView } from "./SectionSettingsView";
import { LeafPageView } from "./LeafPageView";
import "./clientCentre.css";

// The CMC-style workspace, shared by the staff client hub's Profile tab (`/clients/[clientId]/profile`)
// and the portal's Business profile tab (`/portal/company`): a client switcher (portal, when there is more than one), the
// in-page department tree, a breadcrumb, and the content area — all driven off ONE fetched
// `CentreProfile` and its live-edited `CentreDraft` (see `useCentreAutosave`).
//
// Routing stays server-driven (the catch-all segment under the caller's page), not client-side
// state — `segments` comes straight from the URL on every render, so a direct link, a back-button
// press and a bookmark all land on the exact right view with no extra plumbing here.
export function ClientCentreShell({
  clientId,
  basePath,
  segments,
  profile,
  isPortal,
  patchAction,
  switcherOptions,
  onSwitchClient,
}: {
  clientId: string;
  basePath: string;
  /** The catch-all segments after the client id, straight from the page's params. */
  segments: string[];
  profile: CentreProfile;
  isPortal: boolean;
  patchAction: (clientId: string, patch: CentrePatch) => Promise<CentreActionResult>;
  /** Portal only (staff move between clients from the Clients list, CC-D8). Rendered only when there
   *  is more than one option — one client goes straight in with no switcher at all. The portal writes
   *  the `gaiada_portal_client` cookie (see `lib/portalCentreClient.ts`) and redirects to
   *  `/portal/company` — the same "pick, persist server-side, redirect" shape `tenant.ts`'s company
   *  switcher already uses, so nothing here needs the client id threaded through every link's href. */
  switcherOptions?: { clientId: string; clientName: string }[];
  onSwitchClient?: (formData: FormData) => Promise<void>;
}) {
  const { draft, update, saveState, saveError } = useCentreAutosave(clientId, profile, patchAction);
  const [treeOpenMobile, setTreeOpenMobile] = useState(false);

  const route = parseSectionRoute(segments);
  const depts = activeDepts(registry, draft.businessType, draft.departments);
  const canEdit = profile.canEdit;
  const readOnlyReason = isPortal
    ? "Your access is view-only. Ask your account manager if you need changes made here."
    : "You don't have permission to edit this client's profile. Ask an admin for access.";
  const currentSectionId = route.kind === "section" ? route.sectionId : null;

  const setProfileField = (key: string, value: string) =>
    update((d) => ({ ...d, profile: { ...d.profile, [key]: value } }), canEdit);
  const setBusinessType = (businessType: string) => update((d) => ({ ...d, businessType }), canEdit);
  const setDeptToggle = (deptId: string, enabled: boolean) =>
    update((d) => ({ ...d, departments: { ...d.departments, [deptId]: enabled } }), canEdit);
  const setConnection = (connId: string, patch: Partial<ConnectionEntry>) =>
    update(
      (d) => ({ ...d, connections: { ...d.connections, [connId]: { ...(d.connections[connId] ?? {}), ...patch } } }),
      canEdit,
    );
  const addCustomConnection = (sectionId: string, name: string) => {
    const id = `x${Math.random().toString(36).slice(2, 10)}`;
    update(
      (d) => ({
        ...d,
        customConnections: { ...d.customConnections, [sectionId]: [...(d.customConnections[sectionId] ?? []), { id, name }] },
      }),
      canEdit,
      { immediate: true }, // see useCentreAutosave.ts: the id must exist server-side before it can be edited
    );
  };
  const removeCustomConnection = (sectionId: string, connId: string) => {
    update((d) => {
      const remaining = (d.customConnections[sectionId] ?? []).filter((c) => c.id !== connId);
      const restConnections = { ...d.connections };
      delete restConnections[connId];
      return { ...d, customConnections: { ...d.customConnections, [sectionId]: remaining }, connections: restConnections };
    }, canEdit);
  };

  let content: ReactNode;
  if (route.kind === "home") {
    content = <HomeView clientId={clientId} basePath={basePath} profile={{ ...profile, businessType: draft.businessType, profile: draft.profile, departments: draft.departments }} />;
  } else if (route.kind === "company") {
    content = (
      <CompanySettingsView
        clientName={profile.clientName}
        draft={draft}
        canEdit={canEdit}
        isPortal={isPortal}
        onFieldChange={setProfileField}
        onBusinessTypeChange={setBusinessType}
        onDeptToggle={setDeptToggle}
      />
    );
  } else {
    const section = findSection(registry, draft.businessType, route.sectionId);
    if (!section) {
      content = <HomeView clientId={clientId} basePath={basePath} profile={profile} />;
    } else {
      const parent = parentOf(registry, draft.businessType, section.id);
      const crumbs = parent && parent.id !== section.id ? [profile.clientName, parent.name, section.name] : [profile.clientName, section.name];
      if (route.sub === "overview") {
        content = (
          <SectionOverviewView
            basePath={basePath}
            section={section}
            profile={{ ...profile, connections: draft.connections, customConnections: draft.customConnections, profile: draft.profile }}
            crumbs={crumbs}
          />
        );
      } else if (route.sub === "settings") {
        content = (
          <SectionSettingsView
            clientName={profile.clientName}
            section={section}
            crumbs={crumbs}
            draft={draft}
            canEdit={canEdit}
            onFieldChange={setProfileField}
            onConnectionChange={setConnection}
            onAddCustomConnection={(name) => addCustomConnection(section.id, name)}
            onRemoveCustomConnection={(connId) => removeCustomConnection(section.id, connId)}
          />
        );
      } else {
        const page = section.pages[route.pageIndex];
        content = page
          ? <LeafPageView clientName={profile.clientName} page={page} crumbs={[...crumbs, page.name]} />
          : <HomeView clientId={clientId} basePath={basePath} profile={profile} />;
      }
    }
  }

  return (
    <div className="cc-workspace">
      <div>
        {switcherOptions && switcherOptions.length > 1 && onSwitchClient && (
          <form action={onSwitchClient} className="cc-switcher">
            <label htmlFor="cc-client-switcher" className="cc-field__label" style={{ display: "block", marginBottom: 4 }}>
              Client
            </label>
            <select
              id="cc-client-switcher"
              name="clientId"
              defaultValue={clientId}
              onChange={(e) => e.currentTarget.form?.requestSubmit()}
            >
              {switcherOptions.map((o) => (
                <option key={o.clientId} value={o.clientId}>{o.clientName}</option>
              ))}
            </select>
          </form>
        )}
        <button
          type="button"
          className="cc-tree-toggle"
          aria-expanded={treeOpenMobile}
          aria-controls="cc-tree-panel"
          onClick={() => setTreeOpenMobile((v) => !v)}
        >
          {treeOpenMobile ? "Hide sections" : "Sections"}
        </button>
        <div id="cc-tree-panel" className={`cc-tree-panel${treeOpenMobile ? " cc-tree-panel--open" : ""}`}>
          <SectionTree
            registry={registry}
            clientId={clientId}
            basePath={basePath}
            businessType={draft.businessType}
            activeDepts={depts}
            currentSectionId={currentSectionId}
            onNavigate={() => setTreeOpenMobile(false)}
          />
        </div>
      </div>
      <div>
        {!canEdit && <p className="cc-readonly-note">{readOnlyReason}</p>}
        {saveState === "saving" && <span className="cc-saved-note">Saving…</span>}
        {saveState === "saved" && <span className="cc-saved-note">Saved</span>}
        {saveState === "error" && <p className="cc-save-error" role="alert">{saveError}</p>}
        {content}
      </div>
    </div>
  );
}
