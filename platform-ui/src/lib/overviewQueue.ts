import "server-only";
// The Now band's one read of the work queue (DW-3c). "Needs you" and "Today" both draw from it, so it is read
// once per request (`cache`) and each block takes what it needs; a second fan-out would double every call.
//
// Scope (owner ruling DW-Q2, plan §11.3: one Overview per company, and Needs you keeps every company's items,
// tagged): the read covers every company the person can reach, built with `accessibleCompanies`, through the same
// `getMyWorkQueue` spine the old home used (R-1). That spine already reads the person's PM tasks with `assignee=me`, which the backend answers as
// ball-or-responsible, so a department's ball tasks are in it without a second read. "Needs you" shows all of
// it; "Today" narrows to the Overview's own company (`itemsOfCompany`), because it is the agenda of this
// workspace's day.
import { cache } from "react";
import type { Me } from "@/lib/platform";
import { accessibleCompanies } from "@/lib/rbac";
import { getMyWorkQueue } from "@/lib/queue";
import type { QueueItem } from "@/lib/queueUrgency";

export interface NowQueueCompany {
  id: string;
  name: string;
  /** False when the company's leg failed outright: none of its items are in the list. */
  included: boolean;
  /** Sources that failed while the rest of the company answered: its items are there, but too few. */
  partialSources: string[];
}

export interface NowQueue {
  /** Every company's items, ranked together. */
  items: QueueItem[];
  companies: NowQueueCompany[];
}

/** The companies whose items are missing or short, by name. Empty means everything was read. */
export function unreadCompanyNames(companies: readonly NowQueueCompany[]): string[] {
  return companies.filter((c) => !c.included || c.partialSources.length > 0).map((c) => c.name);
}

/** One company's items (the Overview's own, for "Today"). */
export function itemsOfCompany(queue: NowQueue, companyId: string): QueueItem[] {
  return queue.items.filter((i) => i.companyId === companyId);
}

/** Throws only when nothing could be read: no company to read, or every company's leg failed. The queue
 *  degrades a failed leg to an empty list with the company marked excluded, and an all-empty list would read
 *  as "nothing needs you", so the widget's boundary says "Unavailable" instead (plan §3.3, §13 trap 4). A
 *  single failed company among several is partial: the others' items show, with a note naming it. */
export const readNowQueue = cache(async (me: Me): Promise<NowQueue> => {
  const companies = accessibleCompanies(me).map((c) => ({ id: c.id, name: c.name }));
  if (companies.length === 0) throw new Error("There is no company to read the work queue for.");
  const queue = await getMyWorkQueue(me, me.userId, companies);
  const legs: NowQueueCompany[] = companies.map((c) => {
    const leg = queue.companies.find((x) => x.id === c.id);
    return { ...c, included: !!leg && leg.included, partialSources: (leg && leg.included && leg.partialSources) || [] };
  });
  if (!legs.some((l) => l.included)) throw new Error("The work queue could not be read.");
  return { items: queue.items, companies: legs };
});
