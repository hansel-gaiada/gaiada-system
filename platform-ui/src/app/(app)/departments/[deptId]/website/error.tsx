"use client";
import "@/components/webdesk/content/content.css";

// Last line of defence: an exception inside a Website page (a bug, not a WebDesk refusal — those are
// results and render through <WdRefusal>). It says so, offers a retry, and never renders half a page.
export default function WebsiteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="wc-notice wc-notice--bad" role="alert" data-testid="wd-page-error">
      <h2>The Website workspace hit an error</h2>
      <p>Something went wrong while drawing this page. Nothing has been saved or published by this error.</p>
      {error.digest && <p className="wc-notice__reason">Reference: {error.digest}</p>}
      <div className="wc-notice__actions">
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={reset}>Try again</button>
      </div>
    </div>
  );
}
