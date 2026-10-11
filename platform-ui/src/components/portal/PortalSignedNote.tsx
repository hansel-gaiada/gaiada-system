import { portalDate } from "@/lib/portal";

// CP-14 — the "Signed — thank you" confirmation, in ONE place, rendered from two sides:
//   * the contract page (server) once the agreement carries the client's signature — the durable
//     state, which is what the client sees after the sign action's refresh and on every later visit;
//   * `PortalSignForm` (client) from its `useActionState` result, for the instant between the action
//     returning and the refreshed page arriving (and if that refresh ever fails to land).
// One component so the two can never say different things. No "use client" and no hooks: it renders
// on either side of the network.
export function PortalSignedNote({ title, signerName, signerTitle, signedAt }: {
  title: string;
  /** From the recorded signature. Absent on the client-side path, which has only the action's `ok`. */
  signerName?: string | null;
  signerTitle?: string | null;
  signedAt?: string | null;
}) {
  return (
    <div className="cp-form__ok" role="status">
      Signed — thank you.{" "}
      {signerName ? (
        <>
          {signerName}
          {signerTitle ? ` (${signerTitle})` : ""} signed {title} for your organisation
          {signedAt ? ` on ${portalDate(signedAt)}` : ""}, and a copy of the agreement stays available on this page.
        </>
      ) : (
        <>Your signature is recorded against {title}, and a copy of the agreement stays available on this page.</>
      )}
    </div>
  );
}
