#!/usr/bin/env node
// MAIL-13 / design §7.6 — `npm run mail:replay-inbound -- --base <url>`.
//
// POSTs the committed adversarial corpus (src/mail/__fixtures__/inbound/) at a RUNNING platform, which
// is the other half of A13's "two ways" — the test suite drives the same corpus in-process against a
// test database, this drives it over the wire at a real deployment. What it adds over the suite:
// the real Fastify pipeline, the real reverse proxy in front of it, real compose env (token, caps, scan
// profile), and a real `mail_messages` row an operator can look at.
//
// USAGE
//   npm run mail:replay-inbound -- --base https://erp.example.invalid \
//        --token "$MAIL_INBOUND_TOKEN" [--signing-key "$MAIL_INBOUND_SIGNING_KEY"] \
//        [--reply-token <live reply_token>] [--reply-token-b <another live reply_token>] \
//        [--reply-domain notify.example.invalid] [--only 10-hostile-html.json] [--json] \
//        [--database-url "$DATABASE_URL"] [--allow-unverified-threading]
//
// GETTING A LIVE REPLY TOKEN (the threading cases need one — a token is minted per outbound mail and
// cannot be committed):
//   docker compose exec -T postgres psql -U platform_app -d gaiada_platform -tAc \
//     "select reply_token from mail_log where reply_token is not null order by created_at desc limit 2"
// Without `--reply-token` the script still runs every case, but the threading cases resolve to the A9
// unmatched path — which is itself worth asserting (it proves the endpoint, the token wall, the caps and
// the rate limiter) and the script says so per case rather than pretending it threaded.
//
// MAIL-29: an HTTP 204 is returned for BOTH "threaded" and "dropped, no matching token" (design A9,
// deliberately — see brevo-payload.ts/intake.ts). That means a `--reply-token` run whose whole
// threading path is silently broken (as MAIL-29's lowercasing bug was, in production, for months)
// still prints every case as PASS on status alone — a status-only check is exactly what let that
// regression through undetected. So: whenever `--reply-token` is supplied, this script now REQUIRES
// database-level proof that at least one `mail_messages` row actually landed on that token's
// `mail_log` row, via `--database-url` — or it exits non-zero and says so, instead of reporting green.
// Pass `--allow-unverified-threading` to explicitly acknowledge you're running without that proof
// (e.g. no DB reachable from where this script runs) and accept a status-only smoke result anyway.
//
// EXIT CODE is 1 if any case's HTTP status differs from the status the corpus expects, OR (when a
// `--reply-token` was supplied) if database-level threading proof was required and either absent
// (no `--database-url`, no `--allow-unverified-threading`) or came back showing zero new rows.
import { readFileSync, readdirSync } from "node:fs";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "src", "mail", "__fixtures__", "inbound");
const TOKEN_HEADER = "x-gaiada-mail-inbound-token";
const SIGNATURE_HEADER = "x-gaiada-mail-inbound-signature";

// The EICAR test string, assembled from parts for the same reason src/mail/inbound/scanner.ts does it:
// so this file is not itself flagged by a virus scanner running over the repository.
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}", "$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!", "$H+H*"].join("");

function parseArgs(argv) {
  const out = {
    base: "", token: "", signingKey: "", replyToken: "", replyTokenB: "",
    replyDomain: "notify.gaiada.invalid", only: "", json: false,
    databaseUrl: process.env.DATABASE_URL || process.env.MAIL_REPLAY_DATABASE_URL || "",
    allowUnverifiedThreading: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? "";
    if (a === "--base") out.base = next();
    else if (a === "--token") out.token = next();
    else if (a === "--signing-key") out.signingKey = next();
    else if (a === "--reply-token") out.replyToken = next();
    else if (a === "--reply-token-b") out.replyTokenB = next();
    else if (a === "--reply-domain") out.replyDomain = next();
    else if (a === "--only") out.only = next();
    else if (a === "--json") out.json = true;
    else if (a === "--database-url") out.databaseUrl = next();
    else if (a === "--allow-unverified-threading") out.allowUnverifiedThreading = true;
  }
  return out;
}

/** Status each case expects from a correctly-behaving endpoint. Mirrors the controller's documented
 *  mapping: 204 for everything that reached the pipeline (threaded / duplicate / ndr / A9 unmatched),
 *  413 only for the total-size cap. Note 07: against a REAL deployment the cap is the deployment's
 *  (default 5 MB) and the ~130 KB fixture is comfortably under it — so 204 is correct there, and the
 *  413 path is the suite's job, where the cap can be scaled. */
const EXPECTED = { "07-oversized-body.json": 204 };
const DEFAULT_EXPECTED = 204;

// MAIL-31 — the one fixture in the corpus whose whole point is a deliberately FIXED
// `provider_message_id` (06's `_meta`: "the second post writes nothing... replay across runs is the
// point"). Named explicitly, the same way `corpus.test.ts` already hardcodes it by filename — this
// corpus is small and versioned, not a place to infer "which fixture is the duplicate one" from a
// heuristic that could silently stop matching if the fixture is edited.
const DUPLICATE_FIXTURE = "06-replayed-provider-id.json";

function signedHeaders(args, payload) {
  const headers = { "content-type": "application/json", [TOKEN_HEADER]: args.token };
  if (args.signingKey) {
    const t = Math.floor(Date.now() / 1000);
    const mac = createHmac("sha256", args.signingKey).update(`${t}.`).update(Buffer.from(payload, "utf8")).digest("hex");
    headers[SIGNATURE_HEADER] = `t=${t},v1=${mac}`;
  }
  return headers;
}

function substitute(text, args, run) {
  return text
    .replace(/\{\{TOKEN\}\}/g, args.replyToken || "REPLAY-NO-LIVE-TOKEN")
    .replace(/\{\{TOKEN_B\}\}/g, args.replyTokenB || args.replyToken || "REPLAY-NO-LIVE-TOKEN-B")
    .replace(/\{\{REPLY_DOMAIN\}\}/g, args.replyDomain)
    .replace(/\{\{RUN\}\}/g, run);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base) {
    console.error("--base <url> is required (e.g. --base https://erp.example.invalid)");
    process.exit(2);
  }
  if (!args.token) {
    console.error("--token is required: the endpoint is FAIL-CLOSED, so a missing token 401s every case");
    process.exit(2);
  }
  const url = `${args.base.replace(/\/$/, "")}/api/mail/inbound/brevo`;
  // A per-invocation nonce so MessageIds are unique across replays — except fixture 06, whose fixed
  // MessageId is the whole point (idempotency across runs).
  const run = `replay${Date.now()}`;

  const names = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort()
    .filter((f) => !args.only || f === args.only);

  // MAIL-29: when a live `--reply-token` is supplied, a 204 on the threading cases is NOT evidence of
  // anything — the A9 unmatched path returns the exact same status. So resolve the token to its
  // `mail_log` row and snapshot its `mail_messages` count BEFORE posting anything, so the after-count
  // can prove (or disprove) that a row actually landed. This is what closes the gap that let MAIL-29
  // ship: a fully broken threading path used to produce an all-green replay.
  let dbCheck = null; // { client, mailLogId, before } | { error } | null (no token, or no DB access)
  if (args.replyToken) {
    if (args.databaseUrl) {
      const client = new Client({ connectionString: args.databaseUrl });
      try {
        await client.connect();
        const found = await client.query(
          `SELECT id FROM mail_log WHERE reply_token = $1`,
          [args.replyToken],
        );
        if (!found.rows[0]) {
          dbCheck = { error: `--reply-token does not match any mail_log row (checked exact-case, as production does)` };
          await client.end();
        } else {
          const mailLogId = found.rows[0].id;
          const before = await client.query(`SELECT count(*)::int AS n FROM mail_messages WHERE mail_log_id = $1`, [mailLogId]);
          dbCheck = { client, mailLogId, before: before.rows[0].n };
        }
      } catch (err) {
        dbCheck = { error: `could not verify via --database-url: ${err instanceof Error ? err.message : String(err)}` };
      }
    } else if (!args.allowUnverifiedThreading) {
      dbCheck = { error: "a --reply-token was supplied with no --database-url — threading cannot be verified (pass --database-url, or --allow-unverified-threading to proceed on HTTP status alone)" };
    }
  }

  // Only meaningful when `--only` narrows the run to fixtures that never reference the token at all
  // (e.g. `--only 04-absent-token.json`) — in that case there is nothing for the DB check to prove,
  // so it should not fail a run that legitimately never attempted to thread anything.
  let anyTokenFixturePosted = false;
  // MAIL-31 — same idea, EXCLUDING the duplicate fixture. This is what gates the aggregate
  // "some new row must have landed somewhere in the whole run" check below: that check cannot tell
  // fixture 06's CORRECT zero-contribution (already deduped) apart from a genuinely broken pipeline
  // when 06 is the only token fixture in the run (e.g. `--only 06-replayed-provider-id.json` on a
  // second invocation, once the fixed provider_message_id has already landed once). `06`'s OWN
  // correctness is proven separately and more precisely below (`duplicateCheck`), keyed off its
  // specific `provider_message_id` rather than an aggregate delta over the whole corpus — so this
  // flag narrows the aggregate check to what it can actually prove, without weakening it for every
  // OTHER threading fixture (which still uses a per-run `{{RUN}}` nonce and is still expected to
  // contribute a genuinely NEW row on every invocation).
  let anyNonDuplicateTokenFixturePosted = false;
  // MAIL-31 — dedicated dedup proof for the duplicate fixture, independent of the aggregate delta
  // above. Populated only when DB verification is actually available (same gate as the aggregate
  // check) and the duplicate fixture is part of this run. `null` means "not applicable" (fixture not
  // run, or no DB access) — NOT "verified"; only `{ok:true}` is a pass.
  let duplicateCheck = null;

  const results = [];
  for (const name of names) {
    const rawText = readFileSync(join(FIXTURE_DIR, name), "utf8");
    if (rawText.includes("{{TOKEN}}") || rawText.includes("{{TOKEN_B}}")) {
      anyTokenFixturePosted = true;
      if (name !== DUPLICATE_FIXTURE) anyNonDuplicateTokenFixturePosted = true;
    }
    const doc = JSON.parse(substitute(rawText, args, run));
    const meta = doc._meta ?? {};
    delete doc._meta;
    for (const item of doc.items ?? []) {
      for (const att of item.Attachments ?? []) {
        if (att.Content === "@eicar") att.Content = Buffer.from(EICAR, "utf8").toString("base64");
      }
    }
    const payload = JSON.stringify(doc);
    const headers = signedHeaders(args, payload);

    let status = 0;
    let error = null;
    try {
      const res = await fetch(url, { method: "POST", headers, body: payload });
      status = res.status;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const expected = EXPECTED[name] ?? DEFAULT_EXPECTED;
    const threadingCase = payload.includes("REPLAY-NO-LIVE-TOKEN");
    results.push({ name, status, expected, ok: status === expected, error, title: meta.title, note: threadingCase ? "no live reply token supplied — resolves to the A9 unmatched path, NOT threading" : null });

    // MAIL-31 — the duplicate fixture's whole point is a FIXED `provider_message_id` (the corpus
    // loop above already posted it once, just like every other fixture). What proves "correctly
    // deduped" rather than "silently dropped" is NOT "delta was zero" (zero is what a dead pipeline
    // also produces) — it is (a) a row for this exact provider_message_id genuinely exists, and
    // (b) posting the IDENTICAL payload a second time, right now, creates no second row. Both legs
    // are required; neither alone distinguishes "broken" from "correct".
    if (name === DUPLICATE_FIXTURE && dbCheck && dbCheck.client) {
      const providerMessageId = doc.items?.[0]?.MessageId ?? null;
      if (!providerMessageId) {
        duplicateCheck = { ok: false, reason: "fixture 06 has no items[0].MessageId to key the dedup check on — fixture may have drifted from its documented shape" };
      } else {
        const selectSql = `SELECT id FROM mail_messages WHERE provider = 'brevo-inbound' AND provider_message_id = $1`;
        const firstRows = (await dbCheck.client.query(selectSql, [providerMessageId])).rows;
        if (firstRows.length === 0) {
          duplicateCheck = {
            ok: false,
            reason: `no mail_messages row exists for provider_message_id=${JSON.stringify(providerMessageId)} after posting fixture 06 — this is the genuinely-broken case (nothing landed), not a correct dedupe`,
          };
        } else if (firstRows.length > 1) {
          duplicateCheck = {
            ok: false,
            reason: `${firstRows.length} mail_messages rows share provider_message_id=${JSON.stringify(providerMessageId)} — the UNIQUE(provider, provider_message_id) index did not dedupe`,
          };
        } else {
          const firstRowId = firstRows[0].id;
          // The explicit redelivery: same bytes, freshly signed (the signature's timestamp tolerance
          // means reusing the first post's `headers` would either replay a stale signature or, once
          // outside tolerance, wrongly fail auth rather than exercise dedup).
          const redeliveryHeaders = signedHeaders(args, payload);
          let redeliveryStatus = 0;
          try {
            const res = await fetch(url, { method: "POST", headers: redeliveryHeaders, body: payload });
            redeliveryStatus = res.status;
          } catch (err) {
            duplicateCheck = { ok: false, reason: `redelivery POST for fixture 06 threw: ${err instanceof Error ? err.message : String(err)}` };
          }
          if (!duplicateCheck) {
            const secondRows = (await dbCheck.client.query(selectSql, [providerMessageId])).rows;
            if (secondRows.length !== 1 || secondRows[0].id !== firstRowId) {
              duplicateCheck = {
                ok: false,
                reason: `redelivering the identical fixture 06 payload changed the row set for provider_message_id=${JSON.stringify(providerMessageId)} (was 1 row [${firstRowId}], now ${secondRows.length} row(s) [${secondRows.map((r) => r.id).join(",")}]) — dedup broken`,
              };
            } else if (redeliveryStatus !== 204) {
              duplicateCheck = { ok: false, reason: `redelivery of fixture 06 returned ${redeliveryStatus}, expected 204 (a re-delivered duplicate must still 204, not error)` };
            } else {
              duplicateCheck = { ok: true, providerMessageId, rowId: firstRowId };
            }
          }
        }
      }
    }
  }

  // Re-query AFTER the corpus ran, and turn the before/after delta into the actual proof.
  let dbVerified = false;
  if (dbCheck && dbCheck.client) {
    const after = await dbCheck.client.query(`SELECT count(*)::int AS n FROM mail_messages WHERE mail_log_id = $1`, [dbCheck.mailLogId]);
    const afterCount = after.rows[0].n;
    const delta = afterCount - dbCheck.before;
    dbCheck.delta = delta;
    if (delta > 0) {
      const latest = await dbCheck.client.query(
        `SELECT id, entity_type, entity_id, from_email, subject, created_at
           FROM mail_messages WHERE mail_log_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [dbCheck.mailLogId, delta],
      );
      dbCheck.rows = latest.rows;
      dbVerified = true;
    }
    await dbCheck.client.end();
  }

  if (args.json) {
    console.log(JSON.stringify({ url, run, results, dbCheck: dbCheck ? { error: dbCheck.error, mailLogId: dbCheck.mailLogId, before: dbCheck.before, delta: dbCheck.delta, rows: dbCheck.rows, verified: dbVerified } : null, duplicateCheck }, null, 2));
  } else {
    console.log(`\nmail:replay-inbound -> ${url}   (run=${run})\n`);
    for (const r of results) {
      const mark = r.ok ? "PASS" : "FAIL";
      console.log(`  [${mark}] ${r.name}  http=${r.status}${r.ok ? "" : ` (expected ${r.expected})`}${r.error ? `  error=${r.error}` : ""}`);
      if (r.title) console.log(`         ${r.title}`);
      if (r.note) console.log(`         NOTE: ${r.note}`);
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n  ${results.length - failed}/${results.length} cases returned the expected status.`);
    if (!args.replyToken) {
      console.log(
        "\n  NO --reply-token WAS SUPPLIED. HTTP statuses above are still meaningful (auth, caps, rate\n" +
        "  limit, and the A9 drop path), but NOTHING was threaded and no mail_messages row was written\n" +
        "  by the threading cases. Supply a live reply_token to produce the row-level evidence the\n" +
        "  MAIL-13 acceptance criteria ask for.\n",
      );
    } else if (!anyTokenFixturePosted) {
      console.log(
        "\n  --reply-token was supplied, but --only narrowed this run to fixture(s) that never reference\n" +
        "  a token placeholder — there is nothing for the database check to prove here, so it was skipped.\n",
      );
    } else if (dbCheck && dbCheck.error) {
      console.log(`\n  THREADING NOT VERIFIED: ${dbCheck.error}\n` +
        "  A 204 on the threading cases is NOT proof anything threaded (MAIL-29: it looks identical to\n" +
        "  the A9 drop path). This run will FAIL for that reason alone unless you re-run with\n" +
        "  --database-url, or pass --allow-unverified-threading to accept a status-only result.\n");
    } else if (dbVerified) {
      console.log(
        `\n  THREADING VERIFIED IN POSTGRES: mail_log ${dbCheck.mailLogId} gained ${dbCheck.delta} ` +
        `mail_messages row(s) during this run:\n`,
      );
      for (const row of dbCheck.rows) {
        console.log(`    id=${row.id} entity_type=${row.entity_type} entity_id=${row.entity_id} from_email=${row.from_email} subject=${JSON.stringify(row.subject)}`);
      }
    } else if (anyNonDuplicateTokenFixturePosted && dbCheck) {
      console.log(
        "\n  THREADING BROKEN: a --reply-token was supplied and every threading case returned 204, but\n" +
        `  zero new mail_messages rows landed on mail_log ${dbCheck.mailLogId}. A 204 is not a pass —\n` +
        "  this is exactly the failure mode MAIL-29 shipped with undetected. Treating this run as FAILED.\n",
      );
    } else if (dbCheck) {
      // MAIL-31 — every token fixture actually posted in THIS run was the duplicate fixture, whose
      // own correct behaviour IS a zero delta (already deduped). The aggregate delta above has
      // nothing to say either way here — see `duplicateCheck` below for the real proof.
      console.log(
        "\n  Aggregate delta was zero, but the only token fixture in this run was the duplicate-provider-\n" +
        "  message-id fixture (06) — a zero delta is its CORRECT outcome, not evidence of breakage. See\n" +
        "  the dedicated duplicate-fixture check below for the real proof.\n",
      );
    }
    if (duplicateCheck) {
      if (duplicateCheck.ok) {
        console.log(
          `\n  DUPLICATE-FIXTURE DEDUP VERIFIED: provider_message_id=${JSON.stringify(duplicateCheck.providerMessageId)} ` +
          `resolves to exactly ONE mail_messages row (${duplicateCheck.rowId}), and posting the IDENTICAL\n` +
          "  payload again just now created no second row (still 204). This is the direct, per-message proof\n" +
          "  that fixture 06's zero-contribution to any aggregate delta is a correct dedupe, not a dead path.\n",
        );
      } else {
        console.log(`\n  DUPLICATE-FIXTURE CHECK FAILED: ${duplicateCheck.reason}\n`);
      }
    }
    if (args.replyToken) {
      console.log(
        "\n  ADDITIONAL MANUAL SPOT-CHECKS (optional, beyond the automatic check above):\n" +
        "    select id, mail_log_id, entity_type, from_email, subject, size_bytes,\n" +
        "           jsonb_array_length(attachments) AS atts\n" +
        "      from mail_messages order by created_at desc limit 20;\n" +
        "    select status, last_error from mail_log where reply_token = '<the token>';\n" +
        "    select * from mail_suppressions;   -- the NDR case should have added exactly one row\n",
      );
    }
  }
  // MAIL-31 — a config/connectivity error (bad --reply-token, no --database-url) still fails the
  // run whenever ANY token fixture posted, duplicate included: nothing could be verified either
  // way. The "delta stayed at zero" branch, in contrast, only fails when a NON-duplicate token
  // fixture was posted — for the duplicate fixture alone, zero is correct, and its own correctness
  // is proven independently by `duplicateCheckFailed` below.
  const configFailed = anyTokenFixturePosted && Boolean(dbCheck && dbCheck.error);
  const aggregateFailed = anyNonDuplicateTokenFixturePosted && Boolean(dbCheck && !dbCheck.error && !dbVerified);
  const threadingFailed = configFailed || aggregateFailed;
  const duplicateCheckFailed = Boolean(duplicateCheck && duplicateCheck.ok === false);
  process.exit(results.some((r) => !r.ok) || threadingFailed || duplicateCheckFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
