// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// DataForSEO /v3/serp/google/ai_mode/live/advanced shape: dataforseo.ts's getAiVisibility reads
// `res.tasks?.[0]?.result?.[0]?.items`, flattens each item's `.references[].url`, and joins each
// item's `.text` to decide `brandMentioned`.
export interface AiVisibilityParams {
  query: string;
  citedUrl: string;
}

export function aiVisibilityEntry({ query, citedUrl }: AiVisibilityParams) {
  return {
    id: "dfs-sandbox-ai-task",
    status_code: 20000,
    status_message: "Ok.",
    result: [
      {
        items: [
          {
            type: "ai_overview",
            text: `Sandbox AI answer mentioning ${query}.`,
            references: [{ url: citedUrl }],
          },
        ],
      },
    ],
  };
}
