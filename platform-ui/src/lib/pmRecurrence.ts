// Client-safe recurrence constants/types (P2-06). Split out of `lib/pm.ts`
// because that module is `server-only`, but these plain string constants are
// needed by the client `NewTaskForm` for its "Repeats" <select>. Same split
// rationale as `tagColors.ts` (client-safe palette out of the server-only PM
// module). `pm.ts` re-exports these so server callers keep importing from "./pm".
export type RecurrenceFreq = "daily" | "weekly" | "biweekly" | "monthly";
export const RECURRENCE_FREQS: RecurrenceFreq[] = ["daily", "weekly", "biweekly", "monthly"];
export const RECURRENCE_LABEL: Record<RecurrenceFreq, string> = {
  daily: "Daily", weekly: "Weekly", biweekly: "Biweekly", monthly: "Monthly",
};
