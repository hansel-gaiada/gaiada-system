// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// DataForSEO "vendor error inside a 200" shape, at the PER-TASK level (SM-49 AC 7): status_code
// 40501 sits in the 40000+ error range dataforseo.ts's assertOk()/postSerpTasks check, but the
// OUTER HTTP response is still a plain 200 — this is the confirmed DataForSEO convention (see
// dataforseo.ts's own file header) of signalling failure inside a successful transport response.
export interface TaskRejectedParams {
  taskId: string;
}

export function taskRejectedEntry({ taskId }: TaskRejectedParams) {
  return {
    id: taskId,
    status_code: 40501,
    status_message: "Invalid Field: 'keyword'.",
    result: null,
  };
}
