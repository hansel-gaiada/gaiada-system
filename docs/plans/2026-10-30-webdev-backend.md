# Web Dev workspace, the backend (WDV-B): plan

**Status:** PLANNED. Planned with the owner on 2026-10-30. Nothing is built.

This is the second half of the WDV program. The first half, the skin, the Today page and the inside pages, is
`docs/plans/2026-10-30-webdev-skin.md`; its §8 listed WDV-B1 to B7, and this plan replaces that list.

**Read first:** §2 (decisions and open questions), then your phase. Every phase starts with its contract ticket:
nothing is built before its BFF and PERMISSION sections are on main, as for SCP.

**What already exists** (checked on main 9456cd23, 2026-10-30; the GitHub blueprint's "no code" banner is stale):
- The `gaiada-erp` GitHub App (installation 157879245, org `gaiadabali`): its key sealed in the vault, installation
  tokens minted per call inside `core/github/github-app.service.ts` `githubRequest()` only, egress pinned to
  `api.github.com`.
- Repo creation from a template behind a D14 approval (GH-12, `core/github/repo-creation.ts`, decided by a company
  admin), site provisioning (`modules/webdev/provisioning.service.ts`), the first scaffold commit
  (`scaffold-commit.ts`), per-site deploy secrets from the vault (M6-P6o), the deploy grant (M6-P4g).
- The repo registry and sync (`github_repos`), the webhook receiver (push, pull_request, workflow_run, check_suite,
  repository, release, deployment_status), the GitHub ledger (`core/github/ledger.ts`, `Gaiada-Activity` trailer).
- Pull requests as read-only rows linked to PM tasks by key (`github_pull_requests`, DW-6f, BFF §34).
- Staging rebuild (WSK-60) and promote to live (M6-P6h, a HIGH approval decided by a second person), both through
  the template's `site.yml`. Rollback is a manual runbook step (WSK-D89 (5)).
- `work_activity` with GitHub, PM, pipeline and WebDesk sources; check-in prefill; the Social report pattern
  (SCP-5: AI draft as a proposal, numbers frozen at submit, a numeric guard).
- Monitoring with `monitor_results` and per-monitor `uptime24h` and `uptime30d` (`UPTIME_RATIO_SQL`).
- Deliverables with a `due_date` column since `0001_core.sql`.

**Not built:** opening, reviewing or merging pull requests from the ERP; branch protection; a way for a person to push
code without a GitHub account; a staging deploy from a merge; rollback; anything that starts a coding agent; any
link to Claude Design; a weekly report; a stage per project; a fleet daily uptime read; a due-deliverables reader.

## 1. Goal

The Web Dev team uses no GitHub seats and never opens github.com. **The ERP is the book of record**: people sign in to
the ERP, and the ERP does everything on GitHub through the company's App. Code moves through the ERP, is reviewed in
the ERP (an AI first, then a person), and is deployed from the ERP. Designs, weekly reports and coding agents live in
the ERP too.

## 2. Decisions and open questions

| ID | Decision |
|---|---|
| WDV-D11 | **No GitHub seat per person.** The ERP is the book of record; it acts on GitHub only through the `gaiada-erp` App, which uses no seat. web@gaiada.com stays the org owner and emergency account. Nobody shares a GitHub login or token (GitHub's terms forbid a login shared by several people; several people may direct one automation identity). Owner, 2026-10-30. |
| WDV-D12 | **Git through the ERP** (option G1). People use normal git, VS Code and Claude Code against an ERP address, `https://erp.gaiada.com/git/<org>/<repo>.git`, signed in with a personal git token. The ERP checks the person, relays the push to GitHub through the App on the **same branch name**, and records who pushed what. Owner, 2026-10-30. |
| WDV-D13 | **Branch model.** Feature branches and `dev` (a shared work branch, no deploy for now) → a pull request → `main` (the reviewed record of every change; nothing deploys from it) → `staging` (moved by the ERP; Node goes to delphi at `<project>.gaiada.com`, WordPress to server B) → `production` (moved by the ERP after a second person approves; Node goes to helios, WordPress to server A). Owner, 2026-10-30. |
| WDV-D14 | **`main`, `staging` and `production` are protected**: only the ERP moves them, both in the gateway and in GitHub's own rules. The head of department may open one repo for direct pushes to `main`. Owner, 2026-10-30. |
| WDV-D15 | **Review (R1): an AI reviews every pull request first, then a person who is not the author approves the merge.** The AI may flag or block; it never approves alone. Owner, 2026-10-30. |
| WDV-D16 | **The B2 defaults**, presented to the owner on 2026-10-30, who asked for the plan to be written with them: (1) one "Create repository" action sets up the template, the four branches, the protection, CI, deploy secrets and the project link; any Web Dev member requests it, the head of department or a company admin approves, never the requester; (2) staging deploys automatically after every merge into `main`, plus a "Deploy to staging" button; a repo may switch to button-only; (3) "Promote to production" keeps today's HIGH approval: the head of department, the GM or a company admin decides, never the requester; (4) every production deploy tags the commit (`release-YYYY-MM-DD-N`); (6) squash merge by default, normal merge per repo; (7) Web Dev members read and push work branches on every active repo, freelance contributors only on their assigned projects' repos, the head of department manages exceptions; (8) git tokens are made on the person's profile, shown once, valid 90 days, revocable, git only; (9) GitHub also protects the three branches, the ERP may speak git to `github.com` (an egress rule change), and the App's 88 permissions are trimmed to what this needs; (10) a pilot on two or three repos, then every repo, then the owner removes the GitHub members. Any of these may be changed by the owner before its ticket starts. |

| ID | Open question | Default until answered |
|---|---|---|
| WDV-Q1 | **Rollback** as "move `production` back to an earlier release, with the same second-person approval". It reverses WSK-D89 (5). | Rollback stays the manual runbook step; WDV-B2k waits. |
| WDV-Q2 | **Which servers are "server A" (WordPress production) and "server B" (WordPress staging)?** | WDV-B2d builds Node targets first; WordPress targets wait for the names. |
| WDV-Q3 | **Which model reviews code and runs agents?** Named providers are the owner's and the superadmin's choice (AIP-D16); live runs one model (AIP-D1). | The gateway's default tier for the AI review; agents wait for Q4. |
| WDV-Q4 | **How coding agents reach a model.** Claude Code needs Anthropic's Messages API: either the AI gateway learns to serve it (usage and budgets stay in one place, AIP-17), or an Anthropic key is stored as an org secret used only by the agent workflow. | Through the gateway; WDV-B7 starts with the gateway ticket. |
| WDV-Q5 | **Do clients approve designs in the portal?** | No: designs are approved inside the ERP in the first version. |
| WDV-Q6 | **When the weekly report drafts itself, and who receives it.** | Drafted Friday 15:00 company time; the head of department reads and acknowledges; not sent to clients. |
| WDV-Q7 | **An Anthropic Admin API key** for Claude seat usage (the Web Dev foundation's OQ-3). | Not used; seat usage is not shown. |

## 3. B2 · Code without GitHub: git, pull requests, review, deploy

### 3.1 The git gateway (WDV-D12)

- **Routes** (git smart HTTP, served by platform-nest behind the edge, with a raised body limit and long timeouts on
  `/git/` only): `GET /git/:org/:repo.git/info/refs?service=git-upload-pack|git-receive-pack`,
  `POST /git/:org/:repo.git/git-upload-pack`, `POST /git/:org/:repo.git/git-receive-pack`.
- **Sign-in:** HTTP Basic; the username is the person's ERP email and the password a personal git token (§3.2). A
  failed sign-in is a plain 401 with no detail, rate-limited per person and per address.
- **Permission:** resolve the org tenant first (GHT-1), find the repo in `github_repos` (unknown or archived: 404),
  then Cerbos: `read` for fetch and clone, `push` for push (the contract names the kind and actions).
- **Ref rules, checked before anything is relayed:** the gateway reads the receive-pack command list (the pkt-lines
  before the pack) and refuses the whole push, with a message git prints, if it updates or deletes `main`, `staging`
  or `production` (unless the head of department opened `main` on this repo), or pushes a `release-*` tag. Every
  other branch passes through with its own name.
- **Relay:** the request is streamed to `https://github.com/<org>/<repo>.git/...` with an installation token minted
  inside platform-nest for that one repo. The token is never logged, stored or returned (the one-chokepoint rule
  holds). `github.com` joins the egress inventory for this route only.
- **Record:** before relaying, a `git_pushes` row (person, repo, each ref's old and new sha, time, result) and the
  ledger's `attempted` row; after, the result row. When GitHub's push webhook arrives, the commit is matched by sha to
  the `git_pushes` row, so `work_activity` credits the person (today such pushes are "unattributed").
- **Not supported in the first version:** Git LFS and SSH. Both are said in the docs and in the gateway's refusal.

### 3.2 Git tokens

- A table of tokens (person, name, a hash only, a short prefix for display, created, expires at most 90 days later,
  last used, revoked). Shown once at creation; listed and revoked on the person's profile ("Git access"); the head of
  department and a company admin can revoke anyone's in their scope. Creating and revoking write activities.
- A short guide on the profile: `git remote set-url origin https://erp.gaiada.com/git/<org>/<repo>.git`, how VS Code
  and Claude Code store the token, and how to clone.

### 3.3 Creating and adopting repositories

- **Create repository** (extends GH-12 and provisioning): template by stack (Astro, Next.js + Nest, WordPress); the
  branches `main`, `dev`, `staging`, `production`; GitHub rulesets on the three protected branches (no push except the
  App, no deletion, no force push); CI from the template, updated so `staging` and `production` deploy from their
  branch (§3.6); deploy secrets per environment (M6-P6o); the staging domain `<project>.gaiada.com` (the DNS task,
  M6-P6p); the project link. Requested by any Web Dev member; approved by the head of department or a company admin,
  never the requester (today only a company admin decides, so the policy changes).
- **Adopt repository** (for the existing repos): adds the missing branches and rulesets to a repo already in the
  registry and links it to a project, through the same approval. Needed before a repo moves to the gateway.

### 3.4 Pull requests in the ERP

- **Read:** pull requests per repo, project and task; one pull request's description, commits, files changed and
  diff (fetched through the App and cached, marked stale on failure), checks (workflow runs, with job logs on demand),
  reviews and the AI review.
- **Write:** open a pull request from a branch into `main` (the Code page offers it after a new branch is pushed),
  edit its title and description, close and reopen.
- **Review** (stored in the ERP, the book of record): approve, request changes or comment, with comments on lines;
  each review names the head sha it reviewed.
- **Merge** (by the App, squash by default): allowed only when a person who is not the author approved the current
  head sha, the required checks pass, the AI review is done and, if it blocked, the approver overrode it with a
  written reason, and there is no conflict. The author is the pull request's opener and everyone who pushed commits to
  it. The squash commit names the author as the person (not the bot), carries the task key and the `Gaiada-Activity`
  trailer. Reviewer distinctness is enforced by the ERP (blueprint §4.8), because on GitHub the bot authors everything.

### 3.5 The AI review (WDV-D15)

On opening and on every new push, a job reviews the pull request: the diff (bounded in size), the task and PRD text,
and the repo's conventions go to the AI gateway (task `code_review`, attributed to the opener, `ai_usage_events`).
It returns a summary, risks, a checklist and line comments; comments on lines that are not in the diff are dropped. The
verdict is pass, flag or block. It never approves. The model follows WDV-Q3.

### 3.6 Staging, production, releases, rollback

- **Staging:** after a merge into `main` (unless the repo is button-only), and on "Deploy to staging", the ERP moves
  `staging` to the merge commit through the App and dispatches the template's deploy for staging; a build row records
  the sha, and the stamp check proves what is running (the WSK-60 pattern).
- **Production:** "Promote to production" proposes the commit running on staging. The existing HIGH approval
  (M6-P6h) decides it; then the ERP moves `production` to that commit, tags it `release-YYYY-MM-DD-N` and dispatches the
  production deploy.
- **Rollback** (only if WDV-Q1 says yes): choose an earlier release; the same HIGH approval; the ERP moves
  `production` back to that tag and deploys it.
- **Targets:** Node staging on delphi, Node production on helios; WordPress staging on server B and production on
  server A (WDV-Q2).

### 3.7 Moving off the GitHub seats

A pilot on two or three Web Dev repos (adopt, switch the remotes, work a week through the gateway), then every active
repo, then the owner removes the GitHub members and the App's permissions are trimmed (the list goes in the contract:
contents, pull requests, actions, workflows, administration for rulesets, secrets and organization secrets, variables,
environments, deployments, read on checks, statuses, metadata and members).

## 4. B7 · Coding agents from a ticket

- **Start with an agent** on a PM task or a change request (Web Dev members with push rights): the ERP creates a work
  branch named with the task key (from `dev`, or `main` for a fix) and dispatches an agent workflow in the repo's own
  GitHub Actions. Claude Code runs there, headless, with the task's brief (title, description, acceptance, the PRD and
  the approved design, B1), limited to that branch; it commits and pushes with the workflow's token. The code never
  runs inside the ERP (WSK-D6 holds).
- **Then** the ERP opens the pull request; the AI review and a person's review apply as for anyone, and the person who
  started the agent counts as an author, so someone else approves.
- **See what it did:** an agent run record (task, repo, branch, who started it, the workflow run, status, cost, the
  pull request), live status from the workflow webhooks, the logs on demand, and the diff.
- **For people:** "Open in Claude Code" on a task copies the clone address, a branch name with the task key and a
  ready prompt with the task's context.
- **Model and budget:** WDV-Q4 (the gateway by default) and the AI budgets (AIP-17); starting needs no approval, as it
  writes only a work branch, and runs stop at the person's or department's budget.

## 5. B1 · Designs per project

- A **Designs** page per project and a department view (the menu's Design entry, `{D}/designs`). A design is a link
  (Claude Design or a claude.ai artifact, Figma, or another URL) with optional exported files (PNG, PDF, HTML)
  uploaded as versions; review rounds reuse the Asset Library's (DW-6h).
- States: draft, in review, approved (by the head of department, never the designer), replaced. One approved design
  per project and screen set.
- **Hand-off:** "Use for build" puts the approved design on the project's pipeline run (its design stage) and into
  every agent brief (B7).
- Claude Design offers nothing to import from in this repository's knowledge, so the first version stores links and
  exports only; a deeper link comes when Claude Design offers one. Clients do not see designs yet (WDV-Q5).

## 6. B3 · Your week, the report that drafts itself

- One report per person per week (`YYYY-Www`). States: draft, sent, read by the head. The numbers are live until sent,
  then frozen (the SCP-5 periodic pattern).
- **Sources:** tasks done, commits, pull requests opened, reviewed and merged, deploys to staging and production,
  requests triaged and closed, agent runs, website edits and publishes, hours logged, the week's check-ins.
- **Missing sources are bridged into `work_activity` first:** deploys, ERP pull request reviews and merges, change
  requests, agent runs.
- **Drafting:** at the time in WDV-Q6 a job makes the draft; "Draft with AI" proposes the summary and next week's
  plan through the gateway, refused if it states a number the frozen data does not hold (the SCP-5 numeric guard). The
  person edits, adds a note and sends. The head sees the team's weeks and marks each read; a report not sent by Monday
  10:00 appears in Needs you.
- The Today page's "Your week" card stops being hidden.

## 7. B4, B5, B6 · Reads for the Today page

- **B4 Delivery by stage:** a pure function per project in flight, from its pipeline run, stages, gates, provisioned
  site, designs and PM status: **Brief** (PRD stages or PRD gates open, or a briefing and no run), **Design** (design
  or prototype stage open, or a design in review), **Build** (code stage, provisioning, or open pull requests before
  PM review), **Review** (PM review, customer feedback, PM approval or scope sign-off gates open), **Live** (promoted to
  production this month). A project with no run falls back on its PM status. One read by department, no stored stage.
- **B5 Fleet daily uptime:** one read for the last 30 days, grouped by day in `REPORTS_TZ` with the
  `UPTIME_RATIO_SQL` rules; a day with no data is empty, never 0; maintenance days are marked. A parity test against the
  per-monitor rule.
- **B6 Deliverables due:** a summary read (due in the next 7 days, overdue, open with no due date) by department, as
  the Pulse tile's source and the Today page's; the stale comment in `workspaces.ts` is fixed and the create form offers
  a due date.

## 8. Execution

### 8.1 Model tiers

- **Opus:** every contract ticket (architect), the git gateway, merge rules, the agent workflow's permissions, and the
  review of every Sonnet diff in those areas.
- **Sonnet:** the rest of the build.
- **Haiku:** test scaffolds and mechanical UI wiring.
- Contract text, Cerbos kinds (six artifacts each) and the capability inventory change in the same ticket that needs
  them; DB-backed tests run on sumopod or CI, one gate at a time; every ticket lands in a shared merge train.

### 8.2 Order

1. **B2** first (it is the owner's main goal), then **B7** (it needs B2's pull requests), then **B1**, **B3**.
2. **B4, B5 and B6** are small and independent: they may run in parallel with any of the above.

### 8.3 Tickets and acceptance

| Ticket | Acceptance |
|---|---|
| WDV-B2a Contract | BFF and PERMISSION sections for §3: the gateway, tokens, repo create and adopt, pull requests, reviews, merge, AI review, deploys, releases; Cerbos kinds and actions named; decision rows WDV-D11 to D16 in this plan's log; on main, docs only. |
| WDV-B2b Git tokens | §3.2: table with hash only, profile page, revoke by the person, the head and a company admin, activities; a token never appears in a response after creation (leak scan extended). |
| WDV-B2c Git gateway | §3.1: clone, fetch and push through the ERP with a token; refused without one or without permission; the protected refs and `release-*` refused with a git-printed reason; other branches pass with their names; `git_pushes` and ledger rows; the token never logged; proved on sumopod against a test repo and on live against a pilot repo. |
| WDV-B2d Repo create and adopt | §3.3: one approval creates or adopts a repo with the four branches, the rulesets, CI, secrets, the staging domain and the project link; the approver is the head of department or a company admin and never the requester; Node targets first, WordPress when WDV-Q2 is answered. |
| WDV-B2e Push attribution | Webhook pushes matched by sha to `git_pushes`; `work_activity` credits the person; nothing credited to the bot. |
| WDV-B2f Pull requests: read and open | §3.4 read and write parts; the Code page lists and opens them and offers "Open a pull request" after a new branch. |
| WDV-B2g Reviews and merge | §3.4: reviews on a head sha, line comments, merge only under the stated rules, squash by default with the person as author, the task key and the trailer; self-approval refused in code and in policy. |
| WDV-B2h AI review | §3.5: runs on open and on every push, bounded diff, line comments only on changed lines, verdict pass, flag or block, usage attributed; a block needs the approver's written override. |
| WDV-B2i Staging and production | §3.6: merge deploys staging (or the button does), the build row proves the sha running; promote moves `production`, tags the release and deploys after the HIGH approval. |
| WDV-B2j Protection and permissions | GitHub rulesets on every adopted repo; the egress rule for `github.com`; the App's permissions trimmed to the contract's list (owner step). |
| WDV-B2k Rollback | Only after WDV-Q1: an earlier release back to production through the same HIGH approval. |
| WDV-B2l Pilot | Two or three Web Dev repos worked for a week only through the ERP; findings fixed. |
| WDV-B2m Move every repo | Every active repo adopted; a guide; the team's remotes switched. |
| WDV-B2n Seats freed | Owner step: the GitHub members removed; web@gaiada.com stays the owner. |
| WDV-B7a Contract | §4 in the BFF and PERMISSION contracts; the agent workflow's own GitHub permissions (that branch only). |
| WDV-B7b Model path | WDV-Q4: the gateway serves what Claude Code needs, with usage and budgets, or the owner's alternative. |
| WDV-B7c Agent workflow | The workflow in every template and in adopted repos; limited to one work branch; no secret in logs. |
| WDV-B7d Start, track, review | "Start with an agent" on a task, the run record, live status, logs on demand, the pull request opened by the ERP; the starter cannot approve it. |
| WDV-B7e Open in Claude Code | The copied clone address, branch name and prompt on a task. |
| WDV-B1a Contract | §5 in the contracts. |
| WDV-B1b Designs | The table, the project and department pages, versions and review rounds, approval by the head; the menu's Design entry shown (its ticket removed). |
| WDV-B1c Hand-off | "Use for build" on the pipeline run and in agent briefs. |
| WDV-B3a Contract | §6 in the contracts. |
| WDV-B3b Activity bridges | Deploys, ERP reviews and merges, change requests and agent runs in `work_activity`. |
| WDV-B3c Weekly report | The report, the drafting job, "Draft with AI" with the numeric guard, send, the head's view and "read", the Monday reminder; the Today page card shown. |
| WDV-B4 Delivery by stage | §7 B4 as a read with a pure, tested stage function; the Today page's Delivery card replaces the Projects block. |
| WDV-B5 Fleet daily uptime | §7 B5 with a parity test; the Today page's 30-day strip shown. |
| WDV-B6 Deliverables due | §7 B6; the Pulse tile shown; the stale comment fixed; a due date on the create form. |

### 8.4 Live checks

The live ERP holds mock seed (owner ruling 2026-10-13): live checks may use `hansel@gaiada.com` and the placeholder
logins; sign in once, never retry a failed login (live now locks an account after five failures). The pilot (B2l)
uses real repos and real people, so it starts only when the owner names the pilot repos. `aire-vps` is production and
never a test host.
