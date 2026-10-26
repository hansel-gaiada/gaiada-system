// The ONE list of compiled-in modules. main.ts registers exactly this list, and the impact-registry
// and capability-inventory tests read exactly this list, so a module added here is registered at
// boot AND examined by both audits. Before this file each test kept its own copy of the list, and
// the copies drifted (the impact test lacked finance and lms; the inventory lacked lms).
//
// Add a new module HERE, never as a bare `registerModule(...)` in main.ts.
import type { ModuleContract } from "./contract";
import { agencyModule } from "./agency";
import { pmModule } from "./pm";
import { itModule } from "./it";
import { financeModule } from "./finance";
import { monitoringModule } from "./monitoring";
import { invoiceModule } from "./invoice";
import { clientsModule } from "./clients";
import { knowledgeModule } from "./knowledge";
import { automationConsoleModule } from "./automation-console";
import { hrModule } from "./hr";
import { lmsModule } from "./lms";
import { assistantModule } from "./assistant";
import { searchModule } from "./search";
import { reportsModule } from "./reports";
import { webdevModule } from "./webdev";
import { socialModule } from "./social";

export const COMPILED_IN_MODULES: readonly ModuleContract[] = [
  agencyModule, pmModule, itModule, financeModule, monitoringModule, invoiceModule, clientsModule,
  knowledgeModule, automationConsoleModule, hrModule, lmsModule, assistantModule, searchModule,
  reportsModule, webdevModule, socialModule,
];
