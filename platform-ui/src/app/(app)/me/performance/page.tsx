import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { moduleGate } from "@/lib/modules";
import { readResult } from "@/lib/readResult";
import { getReportDocument } from "@/lib/reports-data";
import { getCheckinHistory } from "@/lib/checkins-data";
import { addDaysIso, SELF_HISTORY_WINDOW_DAYS } from "@/lib/checkins";
import { getMyAppraisals } from "@/lib/appraisals-data";
import { getMyLearning } from "@/lib/lms";
import { readMyTimeEntries } from "@/lib/entities";
import { personReportParams, todayIso } from "@/lib/overviewNumbers";
import {
  NUMBERS_PERIOD, appraisalSection, checkinsView, learningSection, moduleOff, numbersHref, numbersSection, sectionOf, timeSection,
  type PerformanceSection, type Section,
} from "@/lib/myPerformance";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { MyPerformance } from "@/components/me/MyPerformance";

// PV7-06: My performance, the person's own picture in one place: this month's numbers, check-ins, the latest
// appraisal, learning, and their own time as context. It lives in the Performance block (`lib/areas.ts`) and copies
// none of the full pages it links to.
//
// Each section reads on its own: `readResult` turns a refused or failed read into data, so one failure says
// "Unavailable" in its own place and never blanks the page or reads as "no training" or "0 h". `getMyLearning`
// rethrows on purpose (see /me/learning); `readResult` here is what makes that safe. A section whose module the
// company switched off is not read and not drawn (`moduleOn` fails open). Every read is the signed-in person's own;
// the server narrows each one. Nothing here is a score.
export default async function MyPerformancePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Performance" title="My performance" />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const modules = await moduleGate(userId, tenant);
  const today = todayIso();
  const off = (s: PerformanceSection) => moduleOff(s, modules.isEnabled);
  /** Read only what the company has the module for; a switched-off section is `off`, never a failed read. */
  const read = async <T,>(s: PerformanceSection, run: () => Promise<Section<T>>): Promise<Section<T>> => (off(s) ? { kind: "off" } : run());

  const [numbers, checkins, appraisal, learning, time] = await Promise.all([
    read("numbers", async () => numbersSection(await readResult(getReportDocument(tenant, userId, personReportParams(userId, NUMBERS_PERIOD, today))))),
    read("checkins", async () =>
      sectionOf(
        await readResult(getCheckinHistory(tenant, userId, { from: addDaysIso(today, -SELF_HISTORY_WINDOW_DAYS), to: today })),
        checkinsView,
      )),
    read("appraisal", async () => appraisalSection(await readResult(getMyAppraisals(tenant, userId)))),
    read("learning", async () => learningSection(await readResult(getMyLearning(userId, tenant)))),
    read("time", async () => timeSection(await readMyTimeEntries(userId, tenant), today)),
  ]);

  return (
    <>
      <PageHeader eyebrow="Performance" title="My performance" />
      <MyPerformance model={{ numbers, numbersHref: numbersHref(today), checkins, appraisal, learning, time }} />
    </>
  );
}
