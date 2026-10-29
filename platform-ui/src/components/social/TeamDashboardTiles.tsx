// SCP-5d (SCP-Q24), SCP-3f: the pipeline tiles of the Team dashboard, drawn right under the KPI strip and above Needs attention. They ARE the Standard Overview's Social Pulse:
// the same built tiles of the Social Media workspace (`SOCIAL_MEDIA.pulse`, those with a reader), read the same way (`pulseModels`: ONE `GET overview`, each tile its own
// figure) and drawn by the same block (`PulseBlock`). So the two screens cannot disagree: a refused read says "No access" and any other failure "Unavailable", never 0, and
// every tile carries the one SIMULATED mark while the server says the tiles count simulated rows. A placeholder tile (one with a ticket, such as the unanswered inbox) is not drawn,
// as on the Overview. Unlike the Overview's Pulse this never throws when every tile failed: the dashboard's other sections still stand, and each tile says "Unavailable".
import { builtPulseTiles } from "@/lib/overviewPulse";
import type { Me } from "@/lib/platform";
import { pulseModels } from "@/components/overview/widgets/Pulse";
import { PulseBlock } from "@/components/overview/widgets/PulseBlock";
import "@/components/overview/overview.css";

export async function TeamDashboardTiles({ me, tenantId, deptId }: { me: Me; tenantId: string; deptId: string }) {
  const models = await pulseModels({ me, tenantId, deptId, pulse: builtPulseTiles({ workspaceKey: "social-media" }) });
  if (models.length === 0) return null;
  return <div data-section="pipeline-tiles"><PulseBlock tiles={models} title="Pipeline" /></div>;
}
