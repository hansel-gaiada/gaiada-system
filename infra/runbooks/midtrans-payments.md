# Runbook: online payment through Midtrans (PV5-10)

**Status: PROTOTYPED against a simulated Midtrans.** Nothing here has been driven against Midtrans yet. The sandbox drive
(PV5-13 part B) needs the owner's sandbox keys. Contract: `docs/FRONTEND-BFF-CONTRACT.md` §16b and §30c. Code:
`platform-nest/src/payments/`.

Online payment is **off** until the server key is set. While it is off, the portal shows no "Pay online", the checkout
route and `POST /api/webhooks/payments/midtrans` answer 404, and the platform logs one line at boot:
`[payments] online payment is off: MIDTRANS_SERVER_KEY is not set ...`.

## 1. What has to exist before you switch it on

1. **The Midtrans account** (owner). It belongs to ONE legal entity, and every payment lands in that entity's merchant
   balance. Note that company's id in the ERP (`companies.id`).
2. **A clearing account in that company's chart** (Finance). Create an asset account, postable, not a control account, for
   money held at the provider, for example `1125  Midtrans clearing`. Then set it on the billing profile:
   `PUT /api/<companyId>/billing-profile` with `{"gatewayClearingAccountCode": "1125"}` (needs `finance_config` `update`).
   Until it is set, "Pay online" is not offered (`reason: not_ready`).
3. The company's billing profile, an open fiscal period and issued IDR invoices (PV5-04). Only issued IDR invoices with a
   whole-rupiah balance are offered online.

## 2. Keys in the server `.env` (never in the repo; the repo is public)

On the ERP host, in the compose project's `.env` (the same file as the other platform secrets):

```
MIDTRANS_SERVER_KEY=<the SERVER key from the Midtrans dashboard: Settings > Access Keys>
MIDTRANS_ENVIRONMENT=sandbox          # sandbox | production (blank = sandbox)
MIDTRANS_TENANT_ID=<companies.id of the company that owns the merchant account>
# optional
PAYMENTS_CHECKOUT_EXPIRY_MINUTES=     # blank = 1440 (24 h)
PAYMENTS_SWEEP_INTERVAL_MS=           # blank = 30000
```

All five are already listed in the `platform` service's `environment:` block in `infra/compose/docker-compose.vps.yml`
(`${VAR:-}`), so a value in `.env` reaches the container. The client key is not used (we never load Snap's JS popup).

Then recreate the platform container with the usual full compose file set (see `infra/runbooks/deploy-vps.md`; never the
VPS file alone, never `--remove-orphans`). Check the boot line:

```
[payments] online payment is on: midtrans sandbox, merchant company <id>
[payments] notice retry sweep on: every 30000ms
```

The platform **refuses to boot** if the key is set but `MIDTRANS_TENANT_ID` is missing, is not a uuid or is not a company
in the database, or if `MIDTRANS_ENVIRONMENT` is anything but sandbox/production. Unset the key to back out.

## 3. The Midtrans dashboard

In the Midtrans dashboard of the matching environment (sandbox: `dashboard.sandbox.midtrans.com`):

- **Payment Notification URL** (Settings > Configuration):
  `https://erp.gaiada.com/api/webhooks/payments/midtrans`
  It must be reachable from the internet with no auth or VPN. nginx already routes `/api/webhooks/` to platform-nest.
- **Finish / Unfinish / Error Redirect URL:** `https://erp.gaiada.com/portal/invoices`
  Each checkout also asks Midtrans to send the payer back to its own invoice page
  (`/portal/invoices/<id>?checkout=finished`) when `MAIL_LINK_BASE_URL` is set to the real ERP origin; the dashboard URLs
  are the fallback. Those pages only say "We're confirming your payment": nothing is paid by the redirect.
- Leave "Recurring notification" and "Pay account notification" empty; nothing here uses them.

## 4. Checking that it works (sandbox)

1. As a portal contact, open an issued IDR invoice: "Pay online" shows with the amount. Press it: you land on
   `app.sandbox.midtrans.com`. Pay with a sandbox test method (e.g. a virtual account, then the sandbox simulator).
2. Within about a minute the invoice reads Paid. In the database (owner-run, read only):
   - `provider_events`: one `processed` row per notice, `outcome` saying `recorded payment …`;
   - `invoice_payments`: one row `source='gateway', method='online', status='confirmed'`;
   - `finance_ar_receipts`: one receipt into the clearing account, allocated to the AR invoice.
3. A notice that could not be processed stays `received` with `last_error`, is retried by the sweep, and after 30 attempts
   (about a day) becomes `failed`; Finance managers (or the owners) are notified.

Record in the hand-back what was confirmed (the dedupe key, the notice field formats, the 404 for an unpaid order, the Snap
`expiry` and `callbacks.finish`). They are marked `[UNVERIFIED until the sandbox drive]` in
`platform-nest/src/payments/webhook.controller.ts`, `midtrans.ts` and BFF §30c; update those marks.

## 5. Switching sandbox to production

1. The owner completes Midtrans' business verification and gets the production server key.
2. In the server `.env`: `MIDTRANS_SERVER_KEY=<production key>` and `MIDTRANS_ENVIRONMENT=production`. Change both
   together: a sandbox key against production hosts (or the reverse) fails every call (the boot line warns when the key
   does not look like the environment's).
3. Set the same Notification and Finish URLs in the PRODUCTION dashboard.
4. Recreate the platform container and check the boot line says `midtrans production`.
5. Open checkouts made in the sandbox are useless in production; they lapse on their own (24 h) and a new one is opened
   on the next click.

## 6. What Finance does by hand (v1)

Each online payment is booked **DR clearing / CR receivables** automatically. Finance posts, per Midtrans payout:

- **DR Bank** (the billing profile's receipt account, e.g. 1120) **/ CR clearing** for the net amount paid out;
- **DR a payment-fee expense account** (and **DR PPN Masukan 1170** for any VAT on the fee) **/ CR clearing** for the fee.

The clearing account should return to zero for each payout. Refunds and chargebacks are not automated: the platform
records the notice as `ignored (reversed)`, notifies Finance, and Finance reverses the receipt.
