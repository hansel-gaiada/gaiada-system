import { redirect } from "next/navigation";

// CC-D8 — the Client Centre workspace moved under the client hub as its Profile tab. The section
// segments are unchanged (`parseSectionRoute` reads the same shape), so a deep link keeps its place:
// `/client-centre/:id/mk1/settings` → `/clients/:id/profile/mk1/settings`.
export default async function ClientCentreRedirect({
  params,
}: {
  params: Promise<{ clientId: string; section?: string[] }>;
}) {
  const { clientId, section } = await params;
  const rest = (section ?? []).map(encodeURIComponent).join("/");
  redirect(`/clients/${encodeURIComponent(clientId)}/profile${rest ? `/${rest}` : ""}`);
}
