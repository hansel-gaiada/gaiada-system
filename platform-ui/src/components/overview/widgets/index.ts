// The Overview's widget host (DW-3b): widget key -> the component that draws it. A later ticket adds its
// component here and removes the widget's `ticket` in the registry (`lib/workspaces.ts`); nothing else in
// the frame changes. Both halves are needed: a widget with a component but still ticketed stays hidden
// (`isPlanned`), and one without a component stays hidden too, so a half-done widget never draws.
//
// A widget is a server component. It reads its own data, so a slow or failing read costs only its block:
// the frame wraps each one in Suspense and an error boundary (`WidgetSlot`). Throw when a read fails;
// the boundary says "Unavailable". Never catch and return 0 or an empty list, because a denied or broken
// read would then look like "nothing to do" (plan §3.3, §3.7).
import type { ReactNode } from "react";
import type { Me } from "@/lib/platform";
import type { OverviewWidget, PulseTile } from "@/lib/workspaces";
import type { DeptLauncher } from "@/lib/deptToolkits";
import type { WorkLinks } from "@/lib/overviewWork";
import type { OverviewPeriod } from "@/lib/overview";
import type { OverviewView } from "@/lib/overviewTeam";
import { NeedsYou } from "./NeedsYou";
import { Today } from "./Today";
import { YourNumbers } from "./YourNumbers";
import { MyActivity } from "./MyActivity";
import { Pulse } from "./Pulse";
import { Projects } from "./Projects";
import { Campaigns } from "./Campaigns";
import { Requests } from "./Requests";
import { Learning } from "./Learning";
import { Appraisal } from "./Appraisal";
import { Decisions } from "./Decisions";
import { Company } from "./Company";
import { Departments } from "./Departments";
import { CompanyCampaigns } from "./CompanyCampaigns";
import { CompanyLearning } from "./CompanyLearning";
import { CompanyAppraisals } from "./CompanyAppraisals";

export interface OverviewWidgetProps {
  me: Me;
  tenantId: string;
  period: OverviewPeriod;
  /** The workspace the Overview belongs to: its org node id (null without one) and unit path for gates. */
  deptId: string | null;
  unitPath: readonly string[];
  /** The workspace's tool set (`Workspace.tools`); empty for Company. */
  tools: readonly DeptLauncher[];
  widget: OverviewWidget;
  /** The workspace's built Pulse tiles (DW-3e); empty for Company and for a workspace with none built. */
  pulse?: readonly PulseTile[];
  /** The pages the Work blocks link to, from the workspace tabs in the registry (DW-3f). */
  workLinks?: WorkLinks;
  /** Me or Team (DW-3h). The frame sets "team" only for a head of this workspace's unit who chose it, so a block may
   *  read the team on this alone; omitted means Me. */
  view?: OverviewView;
  /** The workspace's name, for the Team blocks' words ("Waiting on Web Dev"). */
  subjectLabel?: string;
}

export type OverviewWidgetComponent = (props: OverviewWidgetProps) => ReactNode | Promise<ReactNode>;

/** The built blocks. The frame shipped empty in DW-3a/3b; each block is its own ticket and adds its row here. */
export const OVERVIEW_WIDGETS: Readonly<Record<string, OverviewWidgetComponent>> = {
  "needs-you": NeedsYou,
  today: Today,
  "your-numbers": YourNumbers,
  "my-activity": MyActivity,
  pulse: Pulse,
  projects: Projects,
  campaigns: Campaigns,
  requests: Requests,
  learning: Learning,
  appraisal: Appraisal,
  // The company Overview's blocks (DW-3i). Their keys differ from the department blocks' (`campaigns`, `learning`, `appraisal`) on
  // purpose: one key, one component, whichever workspace lists it.
  decisions: Decisions,
  company: Company,
  departments: Departments,
  "company-campaigns": CompanyCampaigns,
  "learning-compliance": CompanyLearning,
  "appraisal-cycle": CompanyAppraisals,
};

export function hasOverviewWidget(key: string, widgets: Readonly<Record<string, OverviewWidgetComponent>> = OVERVIEW_WIDGETS): boolean {
  return Object.prototype.hasOwnProperty.call(widgets, key);
}
