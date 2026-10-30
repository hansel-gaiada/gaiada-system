import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getMyAiUsage } from "@/lib/aiUsage-data";
import { MY_AI_USAGE_PATH, parseMonth } from "@/lib/aiUsage";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { AiUsageView } from "@/components/aiUsage/AiUsageView";
import { MonthPicker } from "@/components/aiUsage/MonthPicker";

// Analytics > My AI use (AIP-05, reinstated by owner ruling AIP-D18: "the rest can see their own usage"; BFF §66.3): the person's OWN month of AI use,
// by surface and day. Counts and money only, never a thread title or any text. Ungated: every staff member of the company holds `read_own`, and the
// server's route reads only the caller's own rows. A person who is not staff of the company (a client contact) is refused by the server, and the
// page says so; it is never drawn as an empty month. The month is a UTC calendar month (`?month=YYYY-MM`, the current one by default).
const TITLE = "My AI use";

export default async function MyAiUsagePage({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Analytics" title={TITLE} />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const sp = await searchParams;
  const month = parseMonth(sp.month);
  const read = await getMyAiUsage(userId, tenant, month);

  return (
    <>
      <PageHeader eyebrow="Analytics" title={TITLE} />
      <MonthPicker month={month} basePath={MY_AI_USAGE_PATH} />
      {read.kind === "ok" ? (
        <AiUsageView month={read.data.month} totals={read.data.totals} bySurface={read.data.bySurface} byDay={read.data.byDay} />
      ) : read.kind === "forbidden" ? (
        <ReadRefusal subject="your AI use in this company" kind="forbidden" detail="It is shown to the company's staff." />
      ) : (
        <ReadRefusal subject="Your AI use" kind="unavailable" reason={read.kind === "unavailable" ? read.reason : undefined} />
      )}
    </>
  );
}
