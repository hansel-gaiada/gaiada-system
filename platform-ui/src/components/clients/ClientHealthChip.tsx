import { STATE_LABEL, type HealthState } from "@/lib/clientHealth";
import "./clientHealthChip.css";

/** The client health state as a chip: its words and its shape (the edge), never colour alone. Shared by the hub's Health
 *  card (PV7-03), the Clients list and the health board (PV7-05). Staff-only: the portal never draws it (L3). */
export function ClientHealthChip({ state }: { state: HealthState }) {
  return (
    <span className={`ch-health-chip ch-health-chip--${state}`} data-state={state}>
      {STATE_LABEL[state]}
    </span>
  );
}
