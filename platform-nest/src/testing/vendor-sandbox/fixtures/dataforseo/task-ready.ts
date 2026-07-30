// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// DataForSEO task_get "ready" shape: status_code 20000 with a `result[0].items` array —
// dataforseo.ts's fetchOneSerp filters `type === "organic"` for the returned SerpResult.items and
// reads serpFeatures presence off the OTHER item types (ai_overview/featured_snippet/
// people_also_ask/local_pack). One of each is included here so a single ready fixture exercises both
// the organic-row mapping and the feature-flag derivation in one shot.
export interface TaskReadyParams {
  taskId: string;
  keyword: string;
}

export function taskReadyEntry({ taskId, keyword }: TaskReadyParams) {
  const slug = encodeURIComponent(keyword.trim().toLowerCase());
  return {
    id: taskId,
    status_code: 20000,
    status_message: "Ok.",
    result: [
      {
        keyword,
        items: [
          { type: "organic", rank_absolute: 1, rank_group: 1, url: `https://sandbox-one.example/${slug}`, title: "Sandbox Result One" },
          { type: "organic", rank_absolute: 2, rank_group: 2, url: `https://sandbox-two.example/${slug}`, title: "Sandbox Result Two" },
          { type: "featured_snippet" },
          { type: "people_also_ask" },
        ],
      },
    ],
  };
}
