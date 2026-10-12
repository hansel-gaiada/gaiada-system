import { Card } from "@/components/ui";
import { parseGithubRepoRequestArgs } from "@/lib/githubRepoApproval";

function Row({ label, testId, children }: { label: string; testId: string; children: React.ReactNode }) {
  return (
    <div>
      <dt style={{ font: "500 11px var(--font-body)", color: "var(--ink-subtle)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</dt>
      <dd data-testid={testId} style={{ margin: "2px 0 0", font: "400 14px var(--font-body)" }}>{children}</dd>
    </div>
  );
}

// The approvals detail page's renderer for a GitHub repo-creation request (GH-12). Without it the row falls through to the generic
// overview (workflow id + tool name only) and the decider cannot see WHICH repository, from what template, or whether it is public.
// A payload that does not parse renders as "unrecognised", never as a confident summary of a guess.
export function GithubRepoRequestSummary({ toolArgs }: { toolArgs: unknown }) {
  const args = parseGithubRepoRequestArgs(toolArgs);
  if (!args) {
    return (
      <Card title="GitHub repository request">
        <p data-testid="github-summary-unrecognised" style={{ margin: 0, color: "var(--ink-muted)" }}>
          Unrecognised request: its arguments are not in the format a repository request has, so nothing is summarised here. Do not approve it unless you know what it is.
        </p>
      </Card>
    );
  }
  return (
    <Card title="GitHub repository request">
      <dl data-testid="github-summary" style={{ margin: 0, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <Row label="Repository" testId="github-summary-name">{args.name}</Row>
        <Row label="Visibility" testId="github-summary-visibility">{args.private ? "Private" : "Public"}</Row>
        <Row label="Template" testId="github-summary-template">{args.template ?? "None (empty repository)"}</Row>
        {args.description && <Row label="Description" testId="github-summary-description">{args.description}</Row>}
      </dl>
      {!args.private && (
        <p data-testid="github-summary-public-warning" style={{ margin: "10px 0 0", font: "600 13px var(--font-body)" }}>
          This repository will be public: anyone can read its code.
        </p>
      )}
      <p style={{ margin: "10px 0 0", color: "var(--ink-muted)" }}>Approving creates the repository on GitHub now.</p>
    </Card>
  );
}
