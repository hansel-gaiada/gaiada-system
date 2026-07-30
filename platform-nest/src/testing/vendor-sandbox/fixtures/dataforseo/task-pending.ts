// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// DataForSEO task_get "still queued" shape: status_code 40602 ("Task In Queue.") on the PER-TASK
// entry — dataforseo.ts's fetchOneSerp treats this exact code as "poll again", never as a failure.
// This is the Standard-queue's own genuine intermediate state, not an error.
export interface TaskPendingParams {
  taskId: string;
}

export function taskPendingEntry({ taskId }: TaskPendingParams) {
  return {
    id: taskId,
    status_code: 40602,
    status_message: "Task In Queue.",
    result: null,
  };
}
