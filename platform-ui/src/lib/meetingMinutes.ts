// PV4-09 — meeting minutes, staff side (BFF §29c). Client-safe types and pure helpers.
//
// The rules the UI follows, all from the backend:
//   - minutes are written as a DRAFT and stay a draft however often they are saved;
//   - "Share with client" is a deliberate act that FREEZES them (a later PUT is 409) and has no undo;
//   - sharing needs a client on the meeting (`clientId`), and a non-blank draft (`shareable`);
//   - `clientVisible` comes from the backend and is rendered from the field only (trap 9).

export const MAX_MINUTES_CHARS = 100_000;

export interface MeetingMinutes {
  id: string;
  bodyMd: string;
  status: "draft" | "shared";
  draftedBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  sharedAt: string | null;
  sharedBy: string | null;
  sharedByName: string | null;
  clientVisible?: boolean;
}

export interface MinutesView {
  meetingId: string;
  clientId: string | null;
  projectId: string | null;
  title: string | null;
  shareable: boolean;
  minutes: MeetingMinutes | null;
}

export type MinutesResult = { ok: true; view: MinutesView } | { ok: false; error: string };

/** Frozen once shared: the editor goes read-only. */
export function minutesFrozen(m: MeetingMinutes | null): boolean {
  return m?.status === "shared";
}

/** Whether to OFFER "Share with client": the meeting has a client, there is a non-blank draft and it is not
 *  already shared. The server re-checks all three (409). */
export function canOfferShare(view: Pick<MinutesView, "clientId" | "minutes">, bodyNow: string): boolean {
  return !!view.clientId && view.minutes?.status !== "shared" && bodyNow.trim().length > 0;
}

export function minutesErrorText(status: number | null, message: string): string {
  if (status === 409) {
    if (/shared|frozen/i.test(message)) return "These minutes were already shared with the client, so they can no longer be changed.";
    if (/client/i.test(message)) return "This meeting has no client, so its minutes can't be shared.";
    if (/blank|empty|no minutes/i.test(message)) return "Write the minutes and save them before sharing.";
    return message || "That conflicts with the current state of the minutes. Reload the page and try again.";
  }
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "This meeting no longer exists.";
  return message || "That did not work. Try again.";
}
