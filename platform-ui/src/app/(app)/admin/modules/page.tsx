import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listCompanies, getFieldDefs } from "@/lib/entities";
import { listModuleCatalog } from "@/lib/adminData";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ModuleToggle } from "@/components/admin/ModuleToggle";
import { FieldDefManager } from "@/components/admin/FieldDefManager";
import { toggleModuleAction, createFieldAction, deleteFieldAction } from "./actions";

// The toggle list comes from the backend's module catalog (every module compiled into the
// running build), NOT from this company's enabled_modules. Deriving it from enabled_modules —
// as this page used to, unioned against a hardcoded ["agency"] — made the toggle ONE-WAY: the
// moment you disabled e.g. hr, its key left the array, its row vanished, and the only way back
// on was a direct API/SQL write. Union with enabledModules anyway so a key that is enabled but
// no longer compiled in (renamed/removed module, or a stale served assignment) still shows and
// can be turned off.

// The D17 custom-field targets.
const ENTITY_TYPES = ["project", "task", "pm_task", "agency_campaign"] as const;

const SUBTITLE =
  "Per-company module enablement and D17 custom-field definitions for projects, tasks and agency campaigns.";

export default async function AdminModulesPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Settings" title="Modules & Custom Fields" subtitle={SUBTITLE} />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  let enabledModules: string[];
  try {
    const companies = await listCompanies(userId);
    const active = companies.find((c) => c.id === tenant);
    enabledModules = active?.enabled_modules ?? [];
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Settings" title="Modules & Custom Fields" subtitle={SUBTITLE} />
          <Card>
            <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
              This page is limited to administrators.
            </p>
          </Card>
        </>
      );
    }
    throw e;
  }

  const catalog = await listModuleCatalog(userId);
  const byKey = new Map(catalog.map((m) => [m.key, m]));
  const moduleKeys = Array.from(new Set([...catalog.map((m) => m.key), ...enabledModules]));

  return (
    <>
      <PageHeader eyebrow="Settings" title="Modules & Custom Fields" subtitle={SUBTITLE} />

      <Card title="Modules">
        {moduleKeys.length === 0 ? (
          <EmptyNote>No modules known for this company yet.</EmptyNote>
        ) : (
          moduleKeys.map((module) => (
            <ModuleToggle
              key={module}
              module={module}
              label={byKey.get(module)?.label}
              paths={byKey.get(module)?.paths}
              enabled={enabledModules.includes(module)}
              action={toggleModuleAction.bind(null, module, !enabledModules.includes(module))}
            />
          ))
        )}
      </Card>

      {await Promise.all(
        ENTITY_TYPES.map(async (entityType) => {
          const defs = await getFieldDefs(userId, tenant, entityType);
          return (
            <Card key={entityType} title={`Custom fields — ${entityType}`} style={{ marginTop: 16 }}>
              <FieldDefManager
                entityType={entityType}
                defs={defs}
                createAction={createFieldAction.bind(null, entityType)}
                deleteAction={deleteFieldAction}
              />
            </Card>
          );
        })
      )}
    </>
  );
}
