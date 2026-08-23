# dept-pm — R3 runbooks (escort mode)

**Empty by design, for now.** R3 is the tier where the agent must NOT hold the capability at all: the
human acts, and the seat guides, verifies each step and records evidence.

`dept-pm` has few genuine R3 actions — its ceiling is `medium_write` and its blast radius is project
state rather than production systems. The candidates to write first, once the `runbook.*` tool
namespace exists (tracker P4):

- **Cancelling a client-committed deliverable** — irreversible reputationally even when it is
  reversible in the database. The row comes back; the conversation with the client does not.
- **Bulk-reassigning ownership across a project** — recoverable, but the recovery is manual and nobody
  notices the mistake until someone's queue is quietly wrong.

## What a runbook must contain (the P4 contract)

1. The steps, one at a time.
2. **The expected output of each step, stated BEFORE the human runs it** — so a wrong result is caught
   at step 3 rather than at the end.
3. A verification the seat performs on what the human pastes back, and a refusal to advance on a
   mismatch. **An agent that just prints instructions is a document with extra latency.**
4. Evidence capture: the transcript becomes the audit record — often better evidence than an automated
   run produces, because a human confirmed each step.

## The rule that makes R3 real

R3 is enforced by the **absence of the tool from this seat's view**, never by a line in
`boundaries.md`. If the seat holds the capability and is merely told not to use it, that is a
suggestion to a stochastic system, not a control.
