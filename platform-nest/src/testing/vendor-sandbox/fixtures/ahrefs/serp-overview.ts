// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// Ahrefs /serp-overview/serp-overview shape — CONFIRMED FREE per ahrefs.ts's own header, but the
// field shape (`positions[].{position,url,title}`) is the documented-example ASSUMPTION that file
// also flags. ahrefs.ts's postSerpTasks filters rows with no `url`.
export interface SerpOverviewParams {
  keyword: string;
}

export function serpOverviewEnvelope({ keyword }: SerpOverviewParams) {
  const slug = encodeURIComponent(keyword.trim().toLowerCase());
  return {
    positions: [
      { position: 1, url: `https://sandbox-one.example/${slug}`, title: "Sandbox Result One" },
      { position: 2, url: `https://sandbox-two.example/${slug}`, title: "Sandbox Result Two" },
      { position: 5, url: null }, // no-URL row — must be filtered out by the driver
    ],
  };
}
