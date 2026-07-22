import { redirect } from "next/navigation";

// Settings landing → first section.
export default function SettingsIndex() {
  redirect("/admin/users");
}
