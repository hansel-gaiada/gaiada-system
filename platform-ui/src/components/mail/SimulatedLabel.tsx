import { SIMULATED_LABEL, type GmailMode } from "@/lib/gmail";
import "./mail.css";

/** DW-D24: in simulated mode (the default) every mail page says so, so no one thinks a message went out. */
export function SimulatedLabel({ mode }: { mode: GmailMode | null | undefined }) {
  if (mode !== "simulated") return null;
  return <p className="gm-sim" role="note">{SIMULATED_LABEL}</p>;
}
