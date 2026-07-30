// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// DataForSEO task_post / live-advanced success shape (SM-05's DfsResponse<T>.tasks[i]): a per-task
// entry echoing the caller's own keyword back under `data.keyword` — dataforseo.ts's postSerpTasks
// reads exactly that field (falling back to the request keyword if absent). status_code 20100 ("Task
// Created.") is below assertOk's 40000 error floor, so this is the SUCCESS path.
export interface TaskCreatedParams {
  taskId: string;
  keyword: string;
}

export function taskCreatedEntry({ taskId, keyword }: TaskCreatedParams) {
  return {
    id: taskId,
    status_code: 20100,
    status_message: "Task Created.",
    data: { keyword },
  };
}
