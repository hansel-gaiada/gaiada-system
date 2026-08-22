import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getOfficeScene } from "@/lib/office-data";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { BackendPending } from "@/components/BackendPending";
import { OfficeCanvas } from "@/components/office/OfficeCanvas";

// The Office — a prototype route (docs/superpowers/plans/2026-08-23-virtual-office-plan.md).
// Staff-only: `(app)/layout.tsx` already redirects an external-client-only session to `/portal`
// before this ever renders, so no additional gate is needed here — same precedent as every other
// page under this route group.
//
// Rooms are REAL (one per org-structure department, via lib/office-data.ts, the same data the
// department consoles and nav already use). Avatars, movement and the whole event spine are NOT —
// O0 (the shared event+presence spine the full plan calls for) is not built, so this reads current
// org data plus clearly-labelled demo fixtures. `OfficeCanvas` carries an unmissable DEMO marker
// for exactly that reason; see its own header for the honesty rules this is built against (plan §3).
export const metadata = { title: "The Office" };
export const dynamic = "force-dynamic";

export default async function OfficePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const scene = await getOfficeScene(userId, tenant);

  return (
    <>
      <PageHeader title="The Office" />

      <BackendPending
        what="Live presence and movement (the O0 event + presence spine — SSE down, batched intent up) is not deployed. Rooms below are real; who is shown and how they move is demo fixture data, refreshed on every visit and never stored."
        contract="docs/superpowers/plans/2026-08-23-virtual-office-plan.md §4.1 (O0)"
      />

      {!tenant ? (
        <EmptyNote>Select a company to see its office.</EmptyNote>
      ) : (
        <OfficeCanvas scene={scene} />
      )}
    </>
  );
}
