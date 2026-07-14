import "server-only";
// Global search — aggregates the list endpoints the UI already consumes and
// filters them by a case-insensitive substring match. No dedicated backend
// search endpoint exists yet; this is a good-enough cross-entity finder that
// lights up further when a real /search endpoint lands.
import { listCompanies, listProjects, listTasks, listCampaigns, listMembers } from "./entities";

export interface SearchHit {
  label: string;
  sublabel?: string;
  href?: string;
  status?: string;
}
export interface SearchGroup {
  key: string;
  label: string;
  hits: SearchHit[];
}

function match(haystack: string | null | undefined, q: string): boolean {
  return !!haystack && haystack.toLowerCase().includes(q);
}

export async function globalSearch(userId: string, tenant: string | null, rawQuery: string): Promise<SearchGroup[]> {
  const q = rawQuery.trim().toLowerCase();
  if (q.length < 2) return [];

  // Each source degrades independently — one failing feed never blanks the page.
  const [companies, projects, tasks, campaigns, members] = await Promise.all([
    listCompanies(userId).catch(() => []),
    tenant ? listProjects(userId, tenant).catch(() => []) : Promise.resolve([]),
    tenant ? listTasks(userId, tenant).catch(() => []) : Promise.resolve([]),
    tenant ? listCampaigns(userId, tenant).catch(() => []) : Promise.resolve([]),
    tenant ? listMembers(userId, tenant).catch(() => []) : Promise.resolve([]),
  ]);

  const groups: SearchGroup[] = [
    {
      key: "companies",
      label: "Companies",
      hits: companies
        .filter((c) => match(c.name, q) || match(c.type, q))
        .map((c) => ({ label: c.name, sublabel: c.type ?? undefined, href: `/companies/${c.id}`, status: c.status })),
    },
    {
      key: "projects",
      label: "Projects",
      hits: projects
        .filter((p) => match(p.name, q))
        .map((p) => ({ label: p.name, href: `/projects/${p.id}`, status: p.status })),
    },
    {
      key: "tasks",
      label: "Tasks",
      hits: tasks
        .filter((t) => match(t.title, q))
        .map((t) => ({ label: t.title, sublabel: t.project_name, href: `/tasks/${t.id}`, status: t.status ?? undefined })),
    },
    {
      key: "campaigns",
      label: "Campaigns",
      hits: campaigns
        .filter((c) => match(c.name, q))
        .map((c) => ({ label: c.name, href: `/agency/${c.id}`, status: c.status })),
    },
    {
      key: "people",
      label: "People",
      hits: members
        .filter((m) => match(m.name, q) || match(m.email, q) || match(m.title, q))
        .map((m) => ({ label: m.name, sublabel: m.title ?? m.email })),
    },
  ];

  return groups.filter((g) => g.hits.length > 0);
}
