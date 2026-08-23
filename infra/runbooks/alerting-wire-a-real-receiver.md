# Runbook — wire Alertmanager to a receiver a human actually reads

**Status: OPEN. This is the highest-priority operational gap in the estate.**
Written 2026-08-23 from live evidence. Tracker: `docs/superpowers/plans/2026-08-22-hermes-PROGRESS.md` (B19).

---

## 1. The finding — measured, not inferred

Alerting is fully built, correctly configured, evaluating 50 rules, and **delivering to nothing**.

Queried against the remote Prometheus (`10.88.0.2:19090`), `ALERTS` over 24h to 2026-08-23:

| Alert | Firing samples (900s step) | ≈ duration |
|---|---|---|
| `GatewayBudgetNearCap` | **51** | ~13 h/day |
| `SyntheticJourneyFailing{journey="gateway-complete"}` | **58** | ~14 h/day |

Alertmanager's active set over the same period contained exactly one alert: **`Watchdog`** — the
`vector(1)` heartbeat that fires by construction.

**Detection worked. Delivery did not.** The estate correctly identified that its AI gateway was
429-ing real user traffic for more than half of every day, and told nobody.

## 2. Why — every destination is a placeholder

From `gaiada-obs-alertmanager-1` on the observability host:

```
ALERT_EMAIL_TO      = ops@notify.gaiada.invalid          ← RFC 2606 reserved: can NEVER resolve
SMTP_FROM           = alerts@notify.gaiada.invalid       ← same
SMTP_SMARTHOST      = mailpit:1025                       ← dev mail SINK
ALERT_WEBHOOK_URL   = http://ntfy.invalid/gaiada-alerts  ← same
DEADMANSSWITCH_URL  = https://hc-ping.invalid/…          ← same
ALERT_CHAT_ID       = 100000000                          ← dummy value
TELEGRAM_BOT_TOKEN  = <set>                              ← set, but INVALID (getMe → ok:false, §3)
```

`.invalid` is reserved by RFC 2606 specifically so it can never resolve. Four of five destinations use
it, and the one credential that looked real is not. This is not misconfiguration drift — it is a
template that was never given real values, in an estate that has been running on it.

**Routing makes it total.** `severity: ticket` (which both firing alerts carry) has no matcher of its
own, so it falls through to the default receiver `default-multi`, whose only two legs are the dead
email and the dummy-chat_id Telegram. `severity: page` routes to `page-all`, which carries the same
dead email. **There is no severity that reaches a human.**

## 3. There is no one-value shortcut — the Telegram token is a placeholder too

My first reading was that `TELEGRAM_BOT_TOKEN` being `<set>` meant a real bot existed and only
`ALERT_CHAT_ID` was missing — a one-value fix. **Checked against the Telegram API, that is wrong:**

```
GET https://api.telegram.org/bot<TOKEN>/getMe  →  {"ok": false}
```

The token is set but invalid. **Every credential and every destination in the alerting path is a
placeholder.** There is no shortest path; a real channel has to be created.

## 4. Pick a channel — ranked by time-to-working

**Recommended: ntfy.** It is the only option with no account, no credential to provision, and no
approval step — which matters when the goal is to stop being deaf TODAY rather than after a
procurement conversation.

1. **ntfy (fastest)** — `ALERT_WEBHOOK_URL=https://ntfy.sh/<a-secret-topic>`. No account, works on phone and
   desktop. Treat the topic name as a credential: anyone who knows it can read your alerts.
2. **Real SMTP** — set `SMTP_SMARTHOST` / `SMTP_USERNAME` / `SMTP_PASSWORD` / `SMTP_FROM` /
   `ALERT_EMAIL_TO` to a mailbox someone reads. Email is the weakest option for pages (people do not
   watch mail at 03:00) but is fine for `severity: ticket`.
3. **Telegram** — create a bot via @BotFather for a real `TELEGRAM_BOT_TOKEN`, then get `ALERT_CHAT_ID`
   as below. Two values, but a good long-term home.
4. **Discord webhook** — `ALERT_WEBHOOK_URL=<discord webhook url>`. Note this is a *different* Discord
   surface from the Pantheon approval channel; do not reuse that channel for alert noise.

**Whatever is chosen, also set `DEADMANSSWITCH_URL`** to a real healthchecks.io (or equivalent) ping
URL. The dead-man's switch is what tells you that *alerting itself* has died — without it, silence is
indistinguishable from health, which is exactly the failure this runbook exists to correct.

## 5. Verify — do not skip this, the whole point is that "configured" ≠ "delivering"

```bash
# 1. Fire a synthetic alert through the real path
curl -s -XPOST http://10.88.0.2:9093/api/v2/alerts -H 'Content-Type: application/json' -d '[{
  "labels":{"alertname":"ManualDeliveryTest","severity":"ticket"},
  "annotations":{"summary":"verifying the receiver actually delivers"}
}]'

# 2. Confirm Alertmanager accepted it
curl -s http://10.88.0.2:9093/api/v2/alerts | grep -o '"alertname":"[^"]*"' | sort -u
```

**Then look at your phone.** The test is not "the API returned 200" — it is *a human received it*.
That distinction is the entire content of this runbook.

Finally, confirm the real rules can reach you: `GatewayBudgetNearCap` should resolve and notify once
delivery works, since the underlying condition was fixed on 2026-08-23 (probe interval 30s → 5 min,
cap usage now ~0.65%).

## 6. Related — do this at the same time

- **MSO-00: kill the resurrected local storage stack.** Rules currently evaluate twice (once on
  `gda-aicenter`, once on the obs host). Two evaluators and two Alertmanagers means "which one would
  have paged me?" has no single answer, and the duplicate is already documented as drift.
- **B18: `GATEWAY_DAILY_CALL_CAP=2000` is an untuned default**, and its counter is **in-memory** — a
  restart silently resets it, so cap exhaustion erases its own evidence. Tune it deliberately once
  alerting works, not before: without delivery you would not learn that the new value was wrong either.
