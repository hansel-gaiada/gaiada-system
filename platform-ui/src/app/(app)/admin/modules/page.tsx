import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listCompanies, getFieldDefs } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ModuleToggle } from "@/components/admin/ModuleToggle";
import { FieldDefManager } from "@/components/admin/FieldDefManager";
import { toggleModuleAction, createFieldAction, deleteFieldAction } from "./actions";

// Modules the UI knows how to render a toggle for, even if a company's
// enabled_modules doesn't (yet) include every one — the platform's module
// registry currently only has "agency", but this list leaves room for more
// without a code change to the toggle rendering itself.
const KNOWN_MODULES = ["agency"];

// The D17 custom-field targets.
const ENTITY_TYPES = ["project", "task", "agency_campaign"] as const;

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
        <PageHeader eyebrow="Admin" title="Modules & Custom Fields" subtitle={SUBTITLE} />
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
          <PageHeader eyebrow="Admin" title="Modules & Custom Fields" subtitle={SUBTITLE} />
          <Card>
            <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>
              This page is limited to administrators.
            </p>
          </Card>
        </>
      );
    }
    throw e;
  }

  const moduleKeys = Array.from(new Set([...KNOWN_MODULES, ...enabledModules]));

  return (
    <>
      <PageHeader eyebrow="Admin" title="Modules & Custom Fields" subtitle={SUBTITLE} />

      <Card title="Modules">
        {moduleKeys.length === 0 ? (
          <EmptyNote>No modules known for this company yet.</EmptyNote>
        ) : (
          moduleKeys.map((module) => (
            <ModuleToggle
              key={module}
              module={module}
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
