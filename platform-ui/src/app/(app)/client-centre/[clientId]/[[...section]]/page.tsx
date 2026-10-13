import { redirect } from "next/navigation";

// CC-D8 — the Client Centre workspace moved under the client hub as its Profile tab. The section
// segments are passed through as they are, so a deep link keeps its place:
// `/client-centre/:id/mk/connections` → `/clients/:id/profile/mk/connections`. An old `<area>/settings` or
// leaf-page tail is then redirected once more by the Profile page itself (PV6-01).
export default async function ClientCentreRedirect({
  params,
}: {
  params: Promise<{ clientId: string; section?: string[] }>;
}) {
  const { clientId, section } = await params;
  const rest = (section ?? []).map(encodeURIComponent).join("/");
  redirect(`/clients/${encodeURIComponent(clientId)}/profile${rest ? `/${rest}` : ""}`);
}
