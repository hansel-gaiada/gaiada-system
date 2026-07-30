# Runbook — WhatsApp Continuity (Warm Standby + Ban Recovery)

**Risk:** the bot's WhatsApp number can be banned at any time (unofficial gateway — accepted
risk, see the risk register / G.5). This runbook keeps the pilot running through it.

## Warm standby (do this BEFORE it happens)

1. Keep a **second aged, warmed number** on a spare device: real SIM, weeks of ordinary human
   usage (chats, calls, status), never bot traffic.
2. Add the standby number **passively** to every monitored group (it never posts). The source
   of truth for "every monitored group" is `wa-chat-bot/config/groups.yaml` — keep it current.
3. Keep the standby phone charged and on the office network; check it weekly.
4. The **Telegram fallback** is the immediate mouthpiece while WA recovers: set
   `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` and register the webhook (see
   `.env.example`) — the same bot pipeline serves both surfaces.

## Recovery procedure (primary number banned)

1. **Announce** on Telegram/management channel that digests may pause for ~an hour.
2. **Swap the session:** stop the bot; in WAHA (`http://localhost:3000/dashboard`) log out the
   dead session, start a new one, scan the QR **with the standby number**. The webhook, secret,
   and bot config are unchanged — chat ids of existing groups stay the same.
3. **Verify group membership:** walk `config/groups.yaml`; the standby is already in every
   group (step 2 above). Any group it is missing from: have a human admin re-add it.
4. **Re-post the monitoring notice** in every monitored group (legal requirement — template in
   `legal/`). New number = employees must see the notice again.
5. **Windows are gap-safe automatically:** digest windows resume from the persisted
   `data/schedule.json` `last_run_at`; messages sent while the bot was down are lost from
   ingestion history (WAHA can't backfill) — the next digest simply covers a longer window of
   what it did receive. Note the outage in the digest if it exceeded a few hours.
6. **Start a new warm standby** immediately — you are now running without a spare.
7. **Post-mortem:** record the ban date/suspected trigger in the risk register; review send
   volume/behavior (long messages to many groups is the usual trigger — keep digests opt-in).

## Prevention notes

- Never use a fresh/unwarmed number; never blast identical messages to many groups at once.
- The scheduler staggers naturally (per-group sends are sequential); keep `POST_TO_GROUPS`
  conservative and management delivery as the primary channel.

---

## Incident log: 2026-07-29 — pairing refused after an abrupt outage (registration `Connection Failure`)

**Symptom.** The Connect button appeared dead: no QR ever rendered. `GET /admin/session/qr`
returned `{"qr": null}`, and WAHA answered its own QR endpoint with
`422 {"status":"STARTING","expected":["SCAN_QR_CODE"]}` — the session never advanced to
`SCAN_QR_CODE`, so there was no QR to fetch. The UI and bot were behaving correctly.

**What the WAHA log actually said** (this is the line that identifies this failure):

```
session:default - not logged in, attempting registration...
session:default - connection errored ... Error: Connection Failure
session:default - Connection closed due to 'Error: Connection Failure', reconnecting...
```

i.e. credentials were cleared, Baileys DID start the pairing/registration flow, and WhatsApp
refused the registration handshake — then retried every ~2s.

**Ruled out, with evidence — don't re-test these first:**
- *Network / ISP.* `wss://web.whatsapp.com/ws/chat` OPENS from inside the waha container, and
  HTTPS to `web.whatsapp.com` returns 200 from the container, the bot container and the host.
  ⚠️ A `wget` test from inside the waha image reports "unreachable" even when the network is
  fine — that image lacks CA certs for wget. Test with `docker exec gaiada-waha-1 node -e ...`
  (Node's TLS stack, the same one Baileys uses), never wget.
- *Stale session state.* Tried stop→start, logout→start (confirmed `creds.json` removed from
  `/app/.sessions/noweb/default`), and a full container restart. Same failure each time.
- *Client version.* Bumped `noweb-2026.6.2` → `noweb-2026.7.1` and the failure was byte-identical,
  so it is NOT a minimum-client-version rejection. Pin rolled back. **Do not re-bump on a hunch.**

**Conclusion.** An upstream WhatsApp-side throttle/block on the number or egress IP. Most likely
earned by a ~2s reconnect storm: when Docker Desktop stopped mid-day the session died and WAHA
retried login every 2-3s for minutes, and subsequent recovery attempts added to it.

**Recovery procedure.**
1. **STOP the session and leave it stopped.** Every retry while blocked extends the block:
   `POST /admin/session/stop` (or the Connect tab's Stop button). Verify quiet with
   `docker logs gaiada-waha-1 --since 60s | grep -c "attempting registration"` → must be 0.
2. **Neutralize auto-restart while blocked.** `WHATSAPP_RESTART_ALL_SESSIONS=True` (the VPS
   default, and the right default normally) makes every `up -d waha` resume the storm instantly.
   A temporary `WHATSAPP_RESTART_ALL_SESSIONS: "False"` override is in
   `infra/compose/docker-compose.local.yml`. **Delete that block once a scan succeeds**, or the
   bot will not auto-recover its session after a host reboot.
3. **Wait.** Minutes to hours; up to ~24h in the worst case. There is no code fix for this state.
4. **Then re-pair:** start the session, wait for `SCAN_QR_CODE`, scan from the phone
   (Linked devices → Link a device), confirm `WORKING`, and re-verify ingestion with
   `GET /admin/ingest/health` (once built) or by watching `messages` grow.

**Prevention (not yet built).** Bounded reconnect with exponential backoff plus a terminal
"operator action needed: re-scan QR" state — the WA-hardening Agent C lane
(`docs/superpowers/plans/2026-07-29-wa-operability-hardening.md`). Until that ships, nothing
distinguishes "starting normally" from "wedged forever", and nothing prevents the storm that
most likely caused this.

**Session-store backup — added 2026-07-29.** `infra/scripts/backup.sh` now snapshots the
`gaiada_waha-sessions` volume (`waha_sessions()`). This incident is why: a re-pair is not
reliably available on demand, so losing the pairing credentials is not a recoverable-in-an-hour
event. The artifact is full WhatsApp account credentials — 0600, never synced anywhere shared
unencrypted. For a clean (not merely crash-consistent) copy, stop the session first.

### Development while the number is blocked

**Owner decision (2026-07-29): the real number is out of the loop until it recovers; development
continues against a WAHA simulator.** Plan:
`docs/superpowers/plans/2026-07-29-waha-sim-dev-harness.md`.

That plan is **dev scaffolding only** and carries a mandatory **go-live teardown checklist** — the
sim is switched off and a real, warmed number takes over with the full safety set (bounded backoff,
outbound ceiling, reply rate limit, verified kill switch, scheduled watchdog) before production.
Read that section before any cutover; behaviour verified only against the sim is **PROTOTYPED**,
never DEV-VERIFIED.
