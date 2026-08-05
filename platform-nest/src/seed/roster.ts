// The agency's people roster + department/division shape — the ONE definition both seeds read.
//
// It lives in its own file (rather than in agency.ts, where it started) because two seeds need it:
// agency.ts builds the org tree from it, and departments.ts seeds each department's project
// portfolio, per-person tasks and HR files from it. Importing it from agency.ts would have made the
// department seed drag in the whole holding seed — including its `require.main` entry point and its
// migrate() import — which is wrong for a seed that must be runnable on its own against an existing
// database.

// Agency employees placed under org-tree nodes (division v-* or, for the no-division
// departments Social Media / GM, the department d-*). Reused people (existing emails)
// resolve to their existing accounts; the rest are created. [email, name, title, target].
export const EMPLOYEES: [string, string, string, string][] = [
  ["gede@gaia.test", "Gede Pratama", "Frontend Developer", "v-webdev"],
  ["komang.adi@gaia.test", "Komang Adi", "Backend Developer", "v-webdev"],
  ["putu.yoga@gaia.test", "Putu Yoga", "Web Maintenance Engineer", "v-webmaint"],
  ["hansel@gaiada.com", "Clement Hansel", "AI Manager", "v-aimgr"],
  ["kadek.sari@gaia.test", "Kadek Sari", "UI/UX Designer", "v-uiux"],
  ["design@gaiada-creative.test", "Citra (Design)", "Senior Designer", "v-design"],
  ["luh.ayu@gaia.test", "Luh Ayu", "Graphic Designer", "v-design"],
  ["wayan.krisna@gaia.test", "Wayan Krisna", "Video Editor", "v-video"],
  ["nyoman.bagus@gaia.test", "Nyoman Bagus", "SEO Specialist", "v-seo"],
  ["kadek.rai@gaia.test", "Kadek Rai", "SEM Specialist", "v-sem"],
  ["copy@gaiada-creative.test", "Dewi (Copy)", "Copywriter", "v-copy"],
  ["putu.wira@gaia.test", "Putu Wira", "Backlink Specialist", "v-backlink"],
  ["made.ayu@gaia.test", "Made Ayu", "Social Media Manager", "d-social"],
  ["komang.dewi@gaia.test", "Komang Dewi", "Content Creator", "d-social"],
  ["owner@gaiada-creative.test", "Ayu (Owner)", "Managing Director", "d-gm"],
  // GM sits above the delivery departments: the MD, the PM who runs delivery, the client lead who
  // owns approvals, and the group exec. They were previously unplaced, which left the GM department
  // console empty and gave three of the app's most-logged-in accounts no org home at all.
  ["pm@gaiada-creative.test", "Budi (PM)", "Project Manager", "d-gm"],
  ["approver@gaiada-creative.test", "Eka (Client Lead)", "Client Lead", "d-gm"],
  ["exec@gaiada.test", "Gaiada Exec", "Group Executive", "d-gm"],
];

export const AGENCY_DEPTS: { id: string; name: string; divisions: [string, string][] }[] = [
  { id: "d-webdev", name: "Web Dev", divisions: [["v-webdev", "Web Dev"], ["v-webmaint", "Web Maintenance"], ["v-aimgr", "AI Manager"], ["v-uiux", "UI/UX"]] },
  { id: "d-creatives", name: "Creatives", divisions: [["v-design", "Design Graphics"], ["v-video", "Video Editor"]] },
  { id: "d-seo", name: "SEO", divisions: [["v-seo", "SEO"], ["v-sem", "SEM"], ["v-copy", "Copywriter"], ["v-backlink", "Backlink"]] },
  { id: "d-social", name: "Social Media", divisions: [] },
  { id: "d-gm", name: "GM", divisions: [] },
];
