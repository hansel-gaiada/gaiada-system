// SCP-3f: the pipeline tiles (GET overview) render here.
//
// A component boundary only (SCP-5d, SCP-Q24): the Team dashboard draws it right under the KPI strip and above Needs attention. SCP-3f replaces the body with the
// pipeline tiles read from `GET overview`; until then it draws nothing, so no empty frame or "coming soon" shows.
export function TeamDashboardTiles(): null {
  return null;
}
