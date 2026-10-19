import "server-only";
// DW-10f-4b — the readers behind Finance > Payables > Freelancers (BFF §61.7, §61.8, as built §61.18). Each returns a `ReadResult`:
// a refused read (403) and a failed one are said in words, never an empty list, because "no freelancers" and "no bills to draft" are
// claims about money. A 200 in the wrong shape is a broken read, never "none": the demo layer answers `[]` to a path it has no fixture
// for, and a drifted backend could do the same.
//
// All three are `finance_ap` `read` (the page is ungated like Payables, DW-7b: `finance_ap` has no UI capability, the server decides).
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import type { FlPreview, Freelancer, FreelancerBill } from "./freelancers";

const list = <T>(rows: T): T => {
  if (!Array.isArray(rows)) throw new Error("The finance read returned an unexpected answer.");
  return rows;
};

/** `GET finance/freelancers`: every person with a rate or a linked vendor, by name. */
export const listFreelancersResult = (u: string, t: string): Promise<ReadResult<Freelancer[]>> =>
  readResult(platformFetch<Freelancer[]>(`/api/${t}/finance/freelancers`, u).then(list));

/** `GET finance/freelancer-bills/preview?periodStart&periodEnd`: what drafting the period would make, per person. The period was validated by the caller. */
export const getFreelancerPreviewResult = (u: string, t: string, periodStart: string, periodEnd: string): Promise<ReadResult<FlPreview>> =>
  readResult(
    platformFetch<FlPreview>(`/api/${t}/finance/freelancer-bills/preview?${new URLSearchParams({ periodStart, periodEnd }).toString()}`, u).then((p) => {
      if (!p || !Array.isArray(p.freelancers)) throw new Error("The finance read returned an unexpected answer.");
      return p;
    }),
  );

/** `GET finance/freelancer-bills`: every freelancer bill, newest period first. The page splits drafts from the rest. */
export const listFreelancerBillsResult = (u: string, t: string): Promise<ReadResult<FreelancerBill[]>> =>
  readResult(platformFetch<FreelancerBill[]>(`/api/${t}/finance/freelancer-bills`, u).then(list));
