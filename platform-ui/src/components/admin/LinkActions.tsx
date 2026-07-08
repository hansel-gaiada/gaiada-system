"use client";
import { useActionState } from "react";
import { Button, Toast } from "@/components/ui";

export interface AdminActionState {
  ok: boolean;
  error?: string;
}

type LinkAction = (prev: AdminActionState | null, formData?: FormData) => Promise<AdminActionState>;

// Row-scoped identity-link actions: Verify (only shown while unverified, and
// requires a confirm — verifying asserts dual-proof trust) and Unlink
// (always available, ghost/destructive). `verify`/`unlink` are already bound
// to the link id by the page. Both degrade gracefully (friendly toast) until
// the backend endpoints land — see lib/adminData.ts.
export function LinkActions({
  verified,
  verify,
  unlink,
}: {
  verified: boolean;
  verify: LinkAction;
  unlink: LinkAction;
}) {
  const [verifyState, verifyFormAction, verifyPending] = useActionState(verify, null);
  const [unlinkState, unlinkFormAction, unlinkPending] = useActionState(unlink, null);

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {!verified && (
        <form
          action={verifyFormAction}
          onSubmit={(e) => {
            if (!window.confirm("Verify this identity link? This marks it as dual-proof trusted.")) {
              e.preventDefault();
            }
          }}
        >
          <Button type="submit" size="sm" disabled={verifyPending}>
            {verifyPending ? "Verifying…" : "Verify"}
          </Button>
        </form>
      )}
      <form
        action={unlinkFormAction}
        onSubmit={(e) => {
          if (!window.confirm("Unlink this identity? The user will need to re-link and re-verify.")) {
            e.preventDefault();
          }
        }}
      >
        <Button type="submit" variant="ghost" size="sm" disabled={unlinkPending}>
          {unlinkPending ? "Unlinking…" : "Unlink"}
        </Button>
      </form>

      {verifyState?.error && <Toast message={verifyState.error} />}
      {verifyState?.ok && <Toast message="Identity link verified." />}
      {unlinkState?.error && <Toast message={unlinkState.error} />}
      {unlinkState?.ok && <Toast message="Identity link unlinked." />}
    </div>
  );
}
