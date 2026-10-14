import "server-only";
// DW-6i UI: the reader behind the Google Drive block of Tools & connections and the task page's "Attach from Google Drive" gate
// (BFF §42.4). It returns a `ReadResult`: a refusal or a failed read is DATA the page renders in words, never "not connected".
// The Picker answer carries a live access token; this reader reduces it to the status (`normalizeStatus` drops the token), so the
// token never reaches a page or a client component's props. The one action that needs it is `loadPickerCredentialsAction`.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { normalizeStatus, pickerPath, type DriveStatus } from "./drive";

/** `GET integrations/google-drive/picker`, as the status only: configured, connected, needs a reconnect, and the account email. */
export const readDriveStatus = (u: string, t: string): Promise<ReadResult<DriveStatus>> =>
  readResult(
    platformFetch<unknown>(pickerPath(t), u).then((raw) => {
      const s = normalizeStatus(raw);
      if (!s) throw new Error("The Google Drive status read returned an unexpected answer.");
      return s;
    }),
  );
