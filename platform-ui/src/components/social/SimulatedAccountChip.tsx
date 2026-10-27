import "@/components/social/simulated-account.css";
import { SIMULATED_ACCOUNT_NOTE } from "@/lib/socialShared";

// SCP-Sb (plan §5): every screen that shows a social account marks a SIMULATED one. The chip says the word; `withNote` adds the sentence beside it (the Connections
// list, where the account is the whole subject), and the chip alone carries the sentence as its title where space is tight (a thread row, a quota strip). The
// word is in the markup, so it is read by a screen reader and is never colour alone.
export function SimulatedAccountChip({ withNote = false }: { withNote?: boolean }) {
  return (
    <>
      <span className="scp-simacct" title={SIMULATED_ACCOUNT_NOTE}>SIMULATED</span>
      {withNote && <span className="scp-simacct__note">{SIMULATED_ACCOUNT_NOTE}</span>}
    </>
  );
}
