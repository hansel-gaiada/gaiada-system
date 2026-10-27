import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { AssuranceNotice } from "./AssuranceNotice";
import { fenceReasonOfResult } from "@/lib/contributorRouting";
import type { WdResult } from "@/lib/webdeskContentModel";

/** The contributor pages' one renderer for a read that did not return data: the fence's `assurance_high_required` is the two-step notice,
 *  everything else is the shared `WdRefusal`. A page returns this BEFORE it touches anything that could draw a list or a form. */
export function ContributorRefusal({ result, subject, retryHref }: { result: Exclude<WdResult<unknown>, { kind: "ok" }>; subject: string; retryHref?: string }) {
  if (fenceReasonOfResult(result) === "assurance_high_required") return <AssuranceNotice />;
  return <WdRefusal result={result} subject={subject} retryHref={retryHref} />;
}
