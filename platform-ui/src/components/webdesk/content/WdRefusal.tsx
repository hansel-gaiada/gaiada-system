import Link from "next/link";
import { BackendPending } from "@/components/BackendPending";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card } from "@/components/ui";
import type { WdResult } from "@/lib/webdeskContentModel";
import "./content.css";

/**
 * The ONE renderer for a read that did not return data (§10 "States").
 *
 * A page does `if (r.kind !== "ok") return <WdRefusal result={r} … />` BEFORE it touches anything
 * that could draw a list or a form. That early return is the structure that makes "editorial
 * unavailable never renders a list or a form" true rather than hoped-for: there is no `data` in
 * scope to render when the kind is not `ok`.
 *
 *   unavailable (editorial_unavailable | network | upstream_error)
 *                  full-page notice: "Editing is unavailable — WebDesk can't be reached. Nothing has been lost."
 *   unavailable (contract_drift)
 *                  a DIFFERENT, louder notice: the BFF answered 2xx with a body that does not match the
 *                  spec. That is a defect in the contract, never an empty site.
 *   forbidden      existing `ReadRefusal`
 *   not_enabled    module switched off -> `EmptyNote`; endpoint not served yet -> `BackendPending`
 *   not_found      plain "no such item" (a real answer, not a refusal)
 */
export function WdRefusal({
  result, subject, retryHref,
}: {
  result: Exclude<WdResult<unknown>, { kind: "ok" }>;
  /** What could not be read, in the page's words: "the Website workspace", "this item". */
  subject: string;
  retryHref?: string;
}) {
  switch (result.kind) {
    case "unavailable": {
      if (result.code === "contract_drift") {
        return (
          <div className="wc-notice wc-notice--bad" role="alert" data-testid="wd-contract-drift">
            <h2>The content API answered with something unexpected</h2>
            <p>
              WebDesk replied, but not in the shape the ERP expects, so nothing is shown rather than a
              wrong answer. This is a contract defect to report — it does <strong>not</strong> mean {subject} is empty.
            </p>
            <p className="wc-notice__reason">{result.reason}</p>
          </div>
        );
      }
      return (
        <div className="wc-notice" role="alert" data-testid="wd-editorial-unavailable">
          <h2>Editing is unavailable</h2>
          <p>WebDesk can&apos;t be reached. Nothing has been lost.</p>
          <p className="wc-notice__reason">{result.reason}</p>
          {retryHref && (
            <div className="wc-notice__actions">
              <Link href={retryHref} className="lux-btn lux-btn--ghost lux-btn--sm">Try again</Link>
            </div>
          )}
        </div>
      );
    }
    case "forbidden":
      return <ReadRefusal subject={subject} kind="forbidden" detail="Ask a Web Dev publisher or a company admin to grant you access." />;
    case "not_enabled":
      return result.reason === "module_disabled" ? (
        <Card title="Module switched off">
          <EmptyNote>The Web Dev module is switched off for this company, so there is no WebDesk content to show. Nothing has been deleted.</EmptyNote>
        </Card>
      ) : (
        <BackendPending
          what="The WebDesk content API isn't served by this deployment yet, so the Website workspace has nothing to read."
          contract="GET /api/:company/modules/webdev/content/sites (WSK-59)"
        />
      );
    case "not_found":
      return (
        <Card title="Not found">
          <EmptyNote>
            {result.slug === "item-not-found" ? "That item does not exist" : result.slug === "collection-not-found" ? "That collection does not exist" : result.slug === "version-not-found" ? "That version does not exist" : "That site does not exist or is not one of your company's"} in WebDesk.
          </EmptyNote>
        </Card>
      );
    case "conflict":
    case "invalid":
      // A READ never produces these. Rendering them loudly beats a blank screen if one ever does.
      return <ReadRefusal subject={subject} kind="unavailable" reason={result.message} />;
  }
}
