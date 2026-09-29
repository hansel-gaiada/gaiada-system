import { redirect } from "next/navigation";

// CC-D8 — the Details tab became "Contacts & meetings". Kept as a redirect so links pasted into chats
// and bookmarks before the rename still land on the right tab.
export default async function ClientDetailsRedirect({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  redirect(`/clients/${clientId}/contacts`);
}
