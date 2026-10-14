import "server-only";
// DW-6i UI: the reader behind the Google Drive block of Tools & connections and the task page's "Attach from Google Drive" gate
// (BFF §42.8 deviation 13). It returns a `ReadResult`: a refusal or a failed read is DATA the page renders in words, never "not
// connected". It reads the STATUS route, which answers from the connection row alone: no token is minted or refreshed and Google
// is never called, so a page view never waits on Google. The one read that carries a token is the Picker read, made only by
// `loadPickerCredentialsAction` on the click. `normalizeStatus` still keeps only the four status fields, whatever comes back.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { normalizeStatus, statusPath, type DriveStatus } from "./drive";

/** `GET integrations/google-drive`: configured, connected, needs a reconnect, and the account email. */
export const readDriveStatus = (u: string, t: string): Promise<ReadResult<DriveStatus>> =>
  readResult(
    platformFetch<unknown>(statusPath(t), u).then((raw) => {
      const s = normalizeStatus(raw);
      if (!s) throw new Error("The Google Drive status read returned an unexpected answer.");
      return s;
    }),
  );
