import { redirect } from "next/navigation";

// CC-D8 — Client Centre is no longer its own sidebar entry: each client's profile is the Profile tab
// of the client hub, and profile completion is a column on the Clients list. This route stays as a
// redirect so bookmarks from alpha.341/342 still land somewhere sensible.
export default function ClientCentreListRedirect() {
  redirect("/clients");
}
