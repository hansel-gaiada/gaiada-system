import { redirect } from "next/navigation";

// The people directory now lives in the HR department console. Individual
// employee pages (/people/[userId]) and invite (/people/new) stay here.
export default function PeopleIndexRedirect() {
  redirect("/hr/people");
}
