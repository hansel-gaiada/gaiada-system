// AD-3 — the prospect-facing surface. NO AuthGuard, NO Cerbos, NO Principal (design §5.1) — the
// ENTIRE authorization is `IntakeTokenGuard`. Modelled on MI-02's
// webdev-change-requests-portal.controller.ts (same "server-derived, never body-trusted"
// discipline), with one structural difference that discipline forces: MI-02's caller has a portal
// session and a PortalScope; this one has neither, so every fact this controller acts on —
// `tenantId`, `leadId`, `tokenId` — comes from `req.intakeToken` (the guard's own resolution),
// never from the request body, a route param the guard didn't itself validate, or the Host header.
//
// Design: docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md
//   §6.1 (submit idempotency — lock, re-read used_at UNDER the lock, 200 on a retry)
//   §7 (scrub every free-text answer before persist; store the redaction count)
//   §8(a) (actor = NULL, the first deliberately non-human actor in the estate)
//   §9.1 (GET /intake/questionnaire so the form can never drift from the stored schema_version)
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Req, UseGuards,
} from "@nestjs/common";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";
import { writeActivity } from "./http";
import { notifyBestEffort } from "./client-notify";
import { scrubText } from "./scrub";
import { IntakeTokenGuard, type IntakeRequest } from "./agency-intake-token.guard";
import { AGENCY_INTAKE_LOCK_NS } from "./agency-intake-tokens.service";
import { QUESTIONNAIRE_SECTIONS, SCHEMA_VERSION, countAnswers } from "./agency-discovery-questionnaire";

// A generous ceiling on the serialized `answers` payload — 127 fields of free text fits comfortably
// under this even with long paragraph answers; it exists to refuse a pathological body before it
// ever reaches a query parameter, not to constrain a genuine answer.
const MAX_ANSWERS_JSON_BYTES = 500_000;

/** Top-level answer ids that are CONTACT-IDENTITY data, not narrative free text, and are therefore
 *  exempt from `scrubText()`. Design §7's scrub exists to catch a PAN or a national ID pasted into a
 *  NARRATIVE field (`compliance`, `anything_else`) — somewhere nobody would think to look for it. It
 *  does not exist to catch an email address in a field whose entire job is BEING an email address:
 *  `scrubText` redacts bare emails on sight, and running it over `contact_email` would silently
 *  rewrite the prospect's own contact address to a literal `[REDACTED-EMAIL]` marker, leaving the
 *  agency a submission it cannot reply to. Same reasoning for `contact_phone` (digit runs are exactly
 *  what the PAN/NIK rules match) and `contact_name`. Named explicitly, in ONE place, so a future
 *  reader does not "simplify" this back to scrubbing everything. */
export const CONTACT_IDENTITY_FIELDS_EXEMPT_FROM_SCRUB = new Set(["contact_name", "contact_email", "contact_phone"]);

/** Runs `scrubText()` (design §7) over every STRING leaf in an arbitrarily-nested answers value —
 *  text/textarea answers, but also checkbox arrays and grid cells, since a prospect can paste a
 *  phone number or an account number into any free-text slot the form offers, not only the ones
 *  typed 'text'/'textarea'. Numbers and booleans (scale answers) pass through untouched — scrubText
 *  operates on strings only, and there is nothing in a scale value TO redact.
 *
 *  Top-level keys in `CONTACT_IDENTITY_FIELDS_EXEMPT_FROM_SCRUB` are copied through VERBATIM and
 *  contribute nothing to the redaction count — see that constant's comment.
 *
 *  Returns the summed redaction count for `agency_discovery_submissions.redactions` (design §7: "so
 *  a reviewer can see that scrubbing happened rather than assuming it"). */
export function scrubAnswers(answers: Record<string, unknown>): { answers: Record<string, unknown>; redactions: number } {
  let redactions = 0;
  function walk(value: unknown): unknown {
    if (typeof value === "string") {
      const scrubbed = scrubText(value);
      redactions += scrubbed.redactions;
      return scrubbed.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(answers)) {
    out[k] = CONTACT_IDENTITY_FIELDS_EXEMPT_FROM_SCRUB.has(k) ? v : walk(v);
  }
  return { answers: out, redactions };
}

@Controller("api")
@UseGuards(IntakeTokenGuard)
export class AgencyIntakePortalController {
  /** The question set + `schema_version` (design §9.1). Static and in-process — no transaction, no
   *  row — so a token that has already been used (but is otherwise valid) may still read this; the
   *  guard's own `token_used` check applies to this route (not the submit one), and there is nothing
   *  further to gate here beyond "the guard let the request through". */
  @Get(":tenantId/intake/questionnaire")
  questionnaire(@Req() _req: IntakeRequest): { schemaVersion: string; sections: typeof QUESTIONNAIRE_SECTIONS } {
    return { schemaVersion: SCHEMA_VERSION, sections: QUESTIONNAIRE_SECTIONS };
  }

  /** Submit. §6.1 verbatim: lock on the token id, re-read `used_at` UNDER the lock (that line is the
   *  fix, not the lock — pipeline-lock.ts:17-25's DEF-2 lesson), already-used returns 200 with the
   *  EXISTING submission id rather than an error, and the insert/token-stamp/lead-flip/event-emit are
   *  one transaction. HttpCode(200) applies to BOTH the fresh-submission and already-submitted
   *  branches deliberately: the prospect cannot act differently on 200 vs 201, and giving the retry
   *  path its own status would be complexity with no caller who benefits from it. */
  @Post(":tenantId/intake/submissions")
  @HttpCode(200)
  async submit(
    @Req() req: IntakeRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { schemaVersion?: string; answers?: Record<string, unknown> },
  ): Promise<{ submissionId: string }> {
    const intake = req.intakeToken;

    // Defence in depth, not the primary gate: IntakeTokenGuard already refuses `kind='open'` for
    // every route (typed `open_intake_not_enabled`), so this can only trip if a future guard change
    // ever let one through. This handler has no OTHER authority to fall back on if that happens.
    if (intake.kind !== "invite" || !intake.leadId) {
      throw new ForbiddenException({ statusCode: 403, reason: "open_intake_not_enabled", message: "open_intake_not_enabled" });
    }

    const rawAnswers = body?.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
      ? body.answers
      : {};
    const serialized = JSON.stringify(rawAnswers);
    if (Buffer.byteLength(serialized, "utf8") > MAX_ANSWERS_JSON_BYTES) {
      throw new BadRequestException("answers payload too large");
    }
    // Accepted but NOT strictly enforced against SCHEMA_VERSION in v1 — there is only one version in
    // existence, so a mismatch cannot yet occur from a form that actually called
    // GET /intake/questionnaire first (design §9.1's whole point). Falls back to the current constant
    // rather than rejecting an omitted value outright, since the field exists to be STORED
    // (§3.3: "meaningless without knowing which question set produced it"), not to gate the write.
    const schemaVersion = typeof body?.schemaVersion === "string" && body.schemaVersion ? body.schemaVersion : SCHEMA_VERSION;

    const { answers: scrubbedAnswers, redactions } = scrubAnswers(rawAnswers);
    const counts = countAnswers(scrubbedAnswers);
    const submissionId = newId();

    const result = await withTenants([tenantId], async (c) => {
      // §6.1: the token is the dedupe key. Lock BEFORE any read whose result this handler then acts
      // on — the FIRST statement inside the transaction, same discipline lockPipelineRun documents.
      await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [AGENCY_INTAKE_LOCK_NS, intake.tokenId]);

      // Re-read UNDER THE LOCK. The guard's own read happened before this transaction even began and
      // is a stale snapshot the moment two requests race — this query, not the lock above it, is what
      // makes the decision correct.
      const tok = await c.query<{
        used_at: string | null; revoked_at: string | null; expires_at: string | null; lead_id: string | null;
      }>(
        `SELECT used_at, revoked_at, expires_at, lead_id FROM agency_intake_tokens WHERE id = $1`,
        [intake.tokenId],
      );
      const row = tok.rows[0];
      if (!row || row.lead_id !== intake.leadId) {
        throw new ForbiddenException({ statusCode: 403, reason: "token_invalid", message: "token_invalid" });
      }
      if (row.revoked_at) throw new ForbiddenException({ statusCode: 403, reason: "token_revoked", message: "token_revoked" });
      if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
        throw new ForbiddenException({ statusCode: 403, reason: "token_expired", message: "token_expired" });
      }
      if (row.used_at) {
        // Already used — a retry is not an error (design §6.1). Return the EXISTING submission id,
        // 200, never 409: the prospect cannot interpret a conflict the way an operator could (the
        // convert path, §6.2, does the opposite for the opposite reason — an operator CAN).
        const existing = await c.query<{ id: string }>(
          `SELECT id FROM agency_discovery_submissions WHERE token_id = $1`,
          [intake.tokenId],
        );
        if (existing.rows[0]) return { submissionId: existing.rows[0].id, alreadySubmitted: true, ownerId: null as string | null };
        // used_at set with no matching submission row is a state this schema should never produce
        // (the same transaction stamps both) — refuse rather than silently mint a second submission
        // for a token that has already been spent by SOMETHING.
        throw new ForbiddenException({ statusCode: 403, reason: "token_invalid", message: "token_invalid" });
      }

      // The lead's most recent prior submission, if any — a re-submit against a RE-MINTED invite for
      // the SAME lead (design §4.1's re-submit branch) supersedes it rather than standing beside it
      // as an unrelated row, which is design §3.2's entire reason `agency_discovery_submissions` is
      // insert-only in the first place.
      const prior = await c.query<{ id: string }>(
        `SELECT id FROM agency_discovery_submissions
          WHERE tenant_id = $1 AND lead_id = $2
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId, intake.leadId],
      );
      const supersedesId = prior.rows[0]?.id ?? null;

      await c.query(
        `INSERT INTO agency_discovery_submissions
           (id, tenant_id, lead_id, token_id, schema_version, answers, meta,
            answered_count, required_answered, required_total, supersedes_id, redactions, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          submissionId, tenantId, intake.leadId, intake.tokenId, schemaVersion,
          JSON.stringify(scrubbedAnswers), JSON.stringify({}),
          counts.answeredCount, counts.requiredAnswered, counts.requiredTotal,
          supersedesId, redactions, config.originSite,
        ],
      );
      await c.query(`UPDATE agency_intake_tokens SET used_at = now() WHERE id = $1`, [intake.tokenId]);
      // `status <> 'converted'` is a small defensive guard beyond §6.1's literal instruction: a
      // converted lead is terminal, and a stray re-used/re-minted token must never flip a real client
      // relationship back to 'submitted' out from under AD-6's conversion record.
      const leadUpd = await c.query<{ owner_id: string | null }>(
        `UPDATE agency_leads SET status = 'submitted', updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status <> 'converted'
          RETURNING owner_id`,
        [intake.leadId, tenantId],
      );
      await emitEvent(c, tenantId, "agency_discovery_submission", submissionId, "agency.lead.submitted", {
        leadId: intake.leadId, tokenId: intake.tokenId, schemaVersion, ...counts, redactions,
      });
      return { submissionId, alreadySubmitted: false, ownerId: leadUpd.rows[0]?.owner_id ?? null };
    });

    if (!result.alreadySubmitted) {
      // Design §8(a): the FIRST deliberately non-human actor in the estate. `actor = NULL`; the truth
      // lives in metadata. `users.kind` (the estate's eventual general answer) has not shipped — this
      // is the dependency named, not solved, here.
      await writeActivity(tenantId, null, "submitted", "agency_discovery_submission", result.submissionId, {
        leadId: intake.leadId, tokenId: intake.tokenId, actorKind: "prospect",
      });
      if (result.ownerId) {
        await notifyBestEffort(tenantId, null, [result.ownerId], "agency.lead.submitted", {
          title: "New discovery submission", href: `/agency/leads/${intake.leadId}`,
          entityType: "agency_lead", entityId: intake.leadId, severity: "info",
        });
      }
    }

    return { submissionId: result.submissionId };
  }
}
