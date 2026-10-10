import "@/components/webdesk/content/content.css";

// §10 "loading — skeleton". One route-level fallback covers every page under /website: the shell
// (header, tabs, rail) is already on screen, so only the body is a placeholder. Nothing here looks
// like data — a grey block never reads as "0 items".
export default function WebsiteLoading() {
  return (
    <div className="wc-skel" role="status" aria-busy="true" aria-label="Loading the Website workspace" data-testid="wd-skeleton">
      <div className="wc-skel__bar wc-skel__bar--lg" />
      <div className="wc-skel__bar" />
      <div className="wc-skel__bar" style={{ width: "80%" }} />
      <div className="wc-skel__bar wc-skel__bar--blk" />
    </div>
  );
}
