// DW-8n: which view /timesheets shows. Your own time by default: the page is also Me › Timesheet, a personal tab. The company
// view is offered only to people who read department-level reports (heads, managers, company admins); asking for it without
// that right falls back to your own. The server still decides what a read returns.
export type TimesheetView = "mine" | "everyone";

export function timesheetView(requested: string | undefined, mayViewEveryone: boolean): TimesheetView {
  return requested === "everyone" && mayViewEveryone ? "everyone" : "mine";
}
