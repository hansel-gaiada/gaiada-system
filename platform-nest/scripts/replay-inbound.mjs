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

  const results = [];
  for (const name of names) {
    const rawText = readFileSync(join(FIXTURE_DIR, name), "utf8");
    if (rawText.includes("{{TOKEN}}") || rawText.includes("{{TOKEN_B}}")) anyTokenFixturePosted = true;
    const doc = JSON.parse(substitute(rawText, args, run));
    const meta = doc._meta ?? {};
    delete doc._meta;
    for (const item of doc.items ?? []) {
      for (const att of item.Attachments ?? []) {
        if (att.Content === "@eicar") att.Content = Buffer.from(EICAR, "utf8").toString("base64");
      }
    }
    const payload = JSON.stringify(doc);
    const headers = { "content-type": "application/json", [TOKEN_HEADER]: args.token };
    if (args.signingKey) {
      const t = Math.floor(Date.now() / 1000);
      const mac = createHmac("sha256", args.signingKey).update(`${t}.`).update(Buffer.from(payload, "utf8")).digest("hex");
      headers[SIGNATURE_HEADER] = `t=${t},v1=${mac}`;
    }

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
    console.log(JSON.stringify({ url, run, results, dbCheck: dbCheck ? { error: dbCheck.error, mailLogId: dbCheck.mailLogId, before: dbCheck.before, delta: dbCheck.delta, rows: dbCheck.rows, verified: dbVerified } : null }, null, 2));
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
    } else if (dbCheck) {
      console.log(
        "\n  THREADING BROKEN: a --reply-token was supplied and every threading case returned 204, but\n" +
        `  zero new mail_messages rows landed on mail_log ${dbCheck.mailLogId}. A 204 is not a pass —\n` +
        "  this is exactly the failure mode MAIL-29 shipped with undetected. Treating this run as FAILED.\n",
      );
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
  const threadingFailed = anyTokenFixturePosted &&
    (Boolean(dbCheck && dbCheck.error) || Boolean(dbCheck && !dbCheck.error && !dbVerified));
  process.exit(results.some((r) => !r.ok) || threadingFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
