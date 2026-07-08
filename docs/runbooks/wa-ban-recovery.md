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
