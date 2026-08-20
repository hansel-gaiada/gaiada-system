# Sensitivity flag review — the 107 keys, for owner sign-off

**Why now:** the `sensitive` flag was decorative until 2026-08-18, when P2-08's dept-head grant gate
became the first thing to act on it (a role carrying a sensitive key routes as an override instead of
being granted directly). The flags have never been owner-reviewed. Owner asked for the list.

**How to read it:** `[baseline]` marks a key that is in the **global `member` bundle** — i.e. every
staff principal already holds it, so the grant gate subtracts it (PERMISSION-CONTRACT §12.2). Those
eleven are the ones worth looking at hardest: a key that is both "sensitive" and "held by everyone"
is a contradiction — either the flag is wrong, or the baseline reach is.

---

## 🔴 What this review found before anyone even ruled on a flag

**`member` can delete any client in the tenant, live.** `core.client.delete` showed up as
`[baseline]`, which prompted the check:

- `cerbos/policies/resource_client.yaml` has TWO rules for `create/update/delete` — one for
  `company_admin`/`manager`, and a second, separate one for `member` — both gated on nothing but
  `inTenant && notLow`. No `owns`, no ownership attribute.
- Live probe against the running engine (a principal whose only grant is `member @ company`):
  `create`, `update`, `delete` → **EFFECT_ALLOW**.
- `clients.controller.ts:80` authorizes `{kind:"client", id, tenantId}` with no ownership attr, so
  nothing narrows the rule at the handler either.

Soft delete (`deleted_at`), audited, recoverable — but it is real reach by an ordinary staff member
over a core business entity, and it is deployed. **Recommendation: split the member rule to
`create`/`update` only and drop `delete`** (agency staff plausibly onboard clients; nobody plausibly
needs every staffer able to remove one). Owner decision, because it removes a capability.

By contrast `core.integration_connection.create/delete/update` — also `[baseline]` — is a FALSE
alarm: that rule is `owns`-gated self-service (manage your own provider link), so the bundle
over-claims but no reach leaks. The distinction is exactly the one the ceiling's catalog marker
(§12.1, decided) needs to encode.

---

## The 107 keys by domain

### core — 42 keys (4 baseline)
`[baseline]` core.client.delete ⚠ **see above — real reach** ·
`[baseline]` core.integration_connection.create / .delete / .update (owns-gated, benign)

Others: automation_approval.decide, .retry · chat_group.add_member, .promote_member, .remove_member ·
client_contact.create, .revoke, .update · company.delete, .update · compliance_gate.update ·
contract.create, .delete, .read, .send, .update · identity_link.delete, .read, .update ·
meeting_recording.relink · org_structure.update · pipeline_gate.decide · position.assign, .unassign ·
role_grant.create, .read, .revoke · rollup.read · service_assignment.accept, .propose, .reconcile,
.relink, .resume, .revoke, .suspend · user.create, .delete, .update

**Worth questioning:** `core.contract.read`, `core.identity_link.read`, `core.rollup.read` and
`core.role_grant.read` are READS flagged sensitive. If a read is sensitive, every role that lists
people or renders a dashboard routes as an override. Recommend un-flagging reads unless the owner
wants them gated.

### hr — 16 keys (3 baseline)
`[baseline]` hr.case.cancel, hr.case.create, hr.case.read (all self-service: your own case) ·
case.delete, .export, .update · employee.create, .delete, .read, .update · leave.decide ·
record.create, .delete, .export, .read, .update

**Note:** `hr.employee.*` are P2-06's new keys. `hr.record.export`/`hr.case.export` are the
genuinely dangerous pair (bulk PD egress) and should stay flagged whatever else changes.

### reports — 14 keys (4 baseline)
`[baseline]` appraisal.ack, appraisal.read, checkin.read, document.read_person ·
appraisal.confirm_evidence, .cycle_admin, .finalize, .submit, .write · checkin.excuse,
.missed_by_unit, .pending_reminders · period.amend, .seal

**Worth questioning:** four of these are baseline self-service reads/acks. `reports.checkin.read`
being sensitive means the baseline role is "sensitive", which is the contradiction above.

### social — 11 · search — 7 · billing — 5 · it — 5 · portal — 4 · agency — 1 · knowledge — 1 · webdev — 1
social: account.connect, .delete · engagement.set_scope · inbox.reply · ledger.admin ·
platform_app.admin · post.cancel, .delete_published, .publish · report.approve, .deliver
search: campaign.apply_manual, .apply_negatives, .launch, .set_budget · ledger.admin ·
report.approve, .deliver
billing: invoice.approve, .create, .delete, .read, .update — **`invoice.read` flagged sensitive is
probably wrong** unless finance data is meant to be override-gated to read
it: account.disable, .enable, .provision, .read, .reset_password — **`it.account.read` same question**
portal: approve_post, decide, pay, sign · agency: approval.approve ·
knowledge: source.update · webdev: provisioned_site.provision

---

## The three questions this list actually poses

1. **Are READS sensitive?** 8-ish keys are reads (`contract.read`, `identity_link.read`,
   `rollup.read`, `role_grant.read`, `invoice.read`, `it.account.read`, `hr.record.read`,
   `hr.case.read`). Flagging a read means any role that can look at the thing needs an approval to be
   granted. Recommend: **no** — un-flag reads except `hr.record.read` (PD).
2. **Should a baseline key ever be sensitive?** Eleven are. Recommend: **no** — a key held by every
   staffer is not authority a grant confers; fix whichever side is wrong (the flag, or the reach —
   `core.client.delete` is the reach being wrong).
3. **`core.client.delete`** — remove `member`'s delete reach? Recommend: **yes**.
