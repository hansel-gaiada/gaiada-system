import type { ReactNode } from "react";
import { PortalSocialToasts } from "@/components/portal/social/PortalSocialToasts";

// SCP-2: the toasts (and the 10-second Undo) of the post approval page live above both of its pages, so a toast survives the list refresh a decision causes
// and the move from the list to a post's own page.
export default function PortalSocialLayout({ children }: { children: ReactNode }) {
  return <PortalSocialToasts>{children}</PortalSocialToasts>;
}
