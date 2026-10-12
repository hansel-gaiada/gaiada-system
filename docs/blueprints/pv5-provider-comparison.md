# PV-5 provider comparison: certified e-signature and hosted payment checkout

> **Status:** `DECIDED` (ticket PV5-03, docs only). **Owner ruling PV-D25, 2026-10-12:** Midtrans is
> approved for payments. VIDA is approved as the certified e-signature provider **for when it is first
> needed**: certified signing (PV5-11) is parked until counsel sets a threshold or a client asks.
> Building our own *certified* signature was rejected, because certified status is recognition as a
> PSrE (Permenkominfo 11/2022), not software.
> **Date read:** every fact below was read on **2026-10-12** from the linked public page, unless the
> cell says otherwise. Pricing pages change; what is quoted is what was seen that day.
> **Reads with:** [`2026-10-12-pv5-contracts-billing-tickets.md`](../plans/2026-10-12-pv5-contracts-billing-tickets.md)
> (PV5-03, PV5-10, PV5-11, design decisions 14 to 17), rulings PV-D8 and PV-D9 in
> [`2026-10-10-three-perspectives.md`](../plans/2026-10-10-three-perspectives.md),
> [`vendor-exit-register.md`](./vendor-exit-register.md) and EST-D-VI1 in
> [`vendor-independence-doctrine.md`](./vendor-independence-doctrine.md).

**How this was done.** Public pages only. No account was opened, no form was submitted, no email
address was entered and no vendor was contacted. Where a page returned an error or sits behind a login,
the cell says so, and the fact is listed in section 5 as `[UNVERIFIED]`.

**Legal points are context for counsel, not advice.** Each is phrased "for counsel to confirm".

---

## 0. The short answer

| | Pick | Runner-up |
|---|---|---|
| **Certified e-signature (PSrE)** | **VIDA** (PT Indonesia Digital Identity) | **Privy** (PT Privy Identitas Digital) |
| **Hosted payment checkout** | **Midtrans** (Snap) | **DOKU** (Checkout) |

Both picks are conditional on what a sales conversation confirms (section 5). The e-signature
comparison is the weaker of the two: only VIDA publishes any per-signature price, and no PSrE publishes
its full API terms. Do not read the pick as "VIDA is cheapest"; read it as "VIDA is the only one whose
published model fits EST-D-VI1 and whose API documentation is public".

---

## 1. E-signature (PSrE): comparison

### 1.1 What the law asks for (for counsel to confirm)

- A **certified** electronic signature uses a certificate issued by an Indonesian PSrE and a certified
  signature-creation device (PP 71/2019 art. 60, as summarised by
  [hukumonline](https://www.hukumonline.com/klinik/a/begini-pembuktian-tanda-tangan-elektronik-di-pengadilan-lt62444b29a4d00)
  and [smartlegal.id](https://smartlegal.id/trending-topic/2022/11/23/tanda-tangan-elektronik-solusi-legalitas-era-digital/),
  read 2026-10-12). An **uncertified** one (a pasted image, a typed name) can still be valid if the six
  conditions of art. 59(3) and UU ITE art. 11 are met, but is weaker as evidence. That is the basis of the
  PV-D8 two tiers.
- Secondary sources disagree on whether PP 71/2019 art. 60 is read as above, and one search result
  suggested a newer regulation may have replaced parts of it. The primary text was not read. Counsel
  should confirm the current instrument (PV5-Q1).
- **Stamp duty (PV5-Q2).** UU 10/2020 sets a fixed duty of Rp10,000 (PMK 134/PMK.03/2021, dated 2021-09-29,
  [JDIH Kemenkeu](https://jdih.kemenkeu.go.id/download/f98f9b34-586a-474d-9ea4-4de09248a46f/134~PMK.03~2021Per.pdf),
  and the DJP page [pajak.go.id](https://www.pajak.go.id/id/artikel/cara-beli-meterai-elektronik-rp10000)).
  Whether it applies to our agreements, or to invoices and receipts above Rp5,000,000, was **not
  confirmed from a primary text** (the Rp5,000,000 threshold did not appear in what was read). For
  counsel. This document only records which providers can *add* an e-Meterai.

### 1.2 Which PSrEs are registered

The official Komdigi list at `https://tte.komdigi.go.id/listpsrenew` **returned HTTP 403 to our fetcher**
on 2026-10-12, so it was not read directly. A search excerpt of that page (2026-10-12) lists, as
Non-Instansi: Peruri, PT Privy Identitas Digital, PT Indonesia Digital Identity (VIDA), PT Vipas
Inovasi Teknologi (Vinotek), PT Solusi Net Internusa (Digisign), PT Tilaka Nusa Teknologi, PT Digital
Tandatangan Asli and PT Grahadi Digital Technology; BSrE (BSSN) is Instansi (government bodies only,
not a commercial option for us). The Komdigi open-data set found is titled "per 2023" and holds no
readable list ([data.komdigi.go.id](https://data.komdigi.go.id/opendata/dataset/daftar-penyelenggara-sertifikasi-elektronik-psre-indonesia-per-tahun-2023)).
Cross-check: the Ministry of Finance names four non-instansi PSrEs for Coretax: Privy (KMK 454/KM.03/2022),
VIDA (KMK 584/KM.03/2022), Vinotek (KMK 134/KM.3/2024), PT Digital Tandatangan Asli (KMK 146/KM.3/2024)
([pajak.go.id](https://www.pajak.go.id/en/node/118904), no page date shown).

**The four compared:** Privy, VIDA, Peruri (PT Peruri Digital Security, product "Sign It") and Digisign
(PT Solusi Net Internusa). **Also registered, not compared in depth:** Tilaka (its site says certified by
Komdigi as a PSrE, API for e-consent and signatures, no public pricing or sandbox,
[tilaka.id](https://tilaka.id)) and Vinotek (site had an expired TLS certificate on 2026-10-12, not read).
Either is a candidate if the pick fails.

### 1.3 Criteria table

| Criterion | **VIDA** | **Privy** | **Peruri (Sign It)** | **Digisign** |
|---|---|---|---|---|
| **Certified under PP 71/2019 (registered PSrE)** | Yes. FAQ: "registered Certificate Authority (PSrE) under Kominfo" ([docs.vida.id FAQ](https://docs.vida.id/identity-stack/sign/introduction/faq.md), 2026-10-12). A search excerpt cites recognition decree SK 179/2019 `[UNVERIFIED]` | Yes. Pricing page: "Certified by PSrE Komdigi RI", WebTrust ([privy.id/api-suite](https://privy.id/api-suite), 2026-10-12) | Yes. "Tanda tangan digital resmi dari PSrE" ([sign-it.id](https://sign-it.id), 2026-10-12) | Yes. Homepage claims "SK Pengakuan Berinduk Nomor 02 Tahun 2026" ([digisign.id](https://digisign.id), 2026-10-12) |
| **Pricing, and any per-seat fee (EST-D-VI1)** | Published: Individu free; **Business Rp175,000/month**; both "Rp30,000 / 10 external digital signatures" (about Rp3,000 each, our arithmetic). Page does not say whether Business is per user ([vida.id/vidasign](https://www.vida.id/vidasign?hsLang=en), 2026-10-12). Enterprise: custom, no price. API billing "works per signature basis" ([FAQ 11](https://docs.vida.id/identity-stack/sign/introduction/faq.md)) | Published: Free (10 signatures/month); Personal Rp54,000/month; **Enterprise Rp225,000 per employee account per month** (the annual page says Rp2,100,000 per year per Employee Account, [privy.id/privysign](https://privy.id/privysign)); Custom: quote. **Employee Account is a per-seat model.** Bisnis.com (via search excerpt, 2026-05-05) quoted Rp175,000/month, which conflicts. API price not published | **Not published.** Pricing is behind "Cek harga"; sign-it.id/pricing returned 404. A reseller (Mekari Sign, via search excerpt) lists Rp465,000/month for 30 signatures and Rp960,000/month for 80, which is a reseller quota, not Peruri's price | **Not published** on the pages read |
| **Signer's certificate: issue and cost** | KYC "through biometrics and KTP" ([VIDA blog](https://vida.id/en/blog/free-online-signatures)); the blog does not mention e-KTP or Dukcapil matching. Cost to signer: not stated; "10 free signatures for new users" | "Every signer uses a verified digital identity"; warranty "up to IDR 3 billion". KYC steps and signer cost not described on the page | Not described. Certificate "diterbitkan oleh Peruri" ([pds.id/e-signature](https://pds.id/e-signature)) | Homepage says it works with Dukcapil (Kemendagri); signer cost not stated |
| **API: envelope, signing link, webhook, signed PDF and certificate** | **Public docs.** VSP OpenAPI: authentication, upload document, **create envelope**, KYC verification, **download signed document** ([docs.vida.id VSP OpenAPI](https://docs.vida.id/identity-stack/sign/digital-signature/vsp-openapi/api-reference.md)); envelope sent "by email or URL". Webhook (Sign Inline): payload `partnerTrxId`, `code`, `eventId`, `signedDocs[].documentUrl`; auth is **Basic or OAuth2 client credentials, no HMAC**; enabled by VIDA's Solution Architect team ([webhook page](https://docs.vida.id/identity-stack/sign/digital-signature/poa-sign-inline-api/api-reference/webhook-notification.md)). Status endpoint, certificate download and retry rules: not in the pages read | Docs exist but are **behind a login** (`docs.privy.id` redirects to OAuth). A third-party SDK shows `upload_document`, `document_status(doc_token)` and a production flag ([landx-id/privy-python-sdk](https://github.com/landx-id/privy-python-sdk)). Enterprise page lists "Custom integration", no details. Signing link, webhook and certificate download: unconfirmed | "API Integration" offered to Enterprise and Government users; dashboard with status tracking ([sign-it.id](https://sign-it.id)). No endpoint detail public | Not found. No public developer documentation was located |
| **e-Meterai can be added (PV5-Q2)** | Yes. e-Meterai API and Desktop docs ([docs.vida.id e-Meterai API](https://docs.vida.id/identity-stack/sign/e-meterai-stamp/api-integration/e-meterai-api.md), listed in the docs index; the page body was not read); signing and stamping on one document | Yes, in Personal, Enterprise and Custom plans. **Rp11,998 per stamp**, no minimum (Bisnis.com and detik, May 2026, via search excerpts; the Bisnis page returned 403) | Yes. "Distributor resmi pertama e-Meterai Peruri" ([sign-it.id](https://sign-it.id)); price not published | Not mentioned on the pages read |
| **Sandbox** | Not mentioned in the Sign docs read. Mock-data pages exist for the Verify products only | Not mentioned on the public pages. SDK has a non-production flag (third party) | Not mentioned | Not found |
| **Exit: export of signed PDFs and audit trail, and validity if we leave** | Signed document is downloadable by API and by `documentUrl`. Audit-log export format not documented in the pages read | "Full audit trail is kept for every document" ([privy.id/api-suite](https://privy.id/api-suite)); export format not stated | "Each document has an audit trail" ([sign-it.id](https://sign-it.id)); export not stated | Not stated. Its CPS is public ([CPS CA Digisign V3.5](https://digisign.id/dokumen/CPS-CA_Digisign_V3.5.pdf), dated 2026-01-15 per search excerpt) |

### 1.4 What the exit really depends on: custody

For every provider the same reasoning holds, and it is why the pick matters less than the custody rule.

- **We store, at signing time:** the signed PDF, the provider's certificate or evidence page, the
  provider's audit record, and the SHA-256 of each, as `files` rows (PV5-11). Leaving then never strands a
  signed contract: we still hold the document.
- **What still breaks after we leave:** re-verifying the signature *with the provider's validation
  service* (it may be switched off), and re-verifying the certificate chain if the provider's CA ceases or
  its root is no longer trusted. A PDF signature embeds the chain, so a standard PDF reader can show it,
  but the certificates expire and revocation (OCSP/CRL) endpoints go away. Mitigation: at signing time
  also store the revocation evidence if the provider returns it `[UNVERIFIED]`, and keep the provider's
  CPS version in force at signing (Digisign publishes its CPS; the others were not checked).
- **Per-signer cost of switching:** a signer's certificate belongs to one PSrE. A client who signed with
  VIDA must be re-verified (KYC) by the next PSrE for the next contract. That is friction, not a stranded
  asset.

### 1.5 Pick and runner-up

**Pick: VIDA.** Reasons, tied to the criteria:

1. **Pricing shape fits EST-D-VI1.** The only published unit price among the four is per external
   signature (Rp30,000 per 10), and VIDA's own FAQ says the API "works per signature basis". The Business
   plan's Rp175,000/month is a flat plan fee whose per-user status is **not stated** (confirm in writing,
   section 5). Privy's published business plan is explicitly per employee account.
2. **The API shape in design decisions 14 and 15 is publicly documented.** Upload, create envelope, KYC and
   download-signed-document are named in public docs; a webhook with a `signedDocs[].documentUrl` exists.
   Because VIDA's webhook carries **no HMAC** (Basic or OAuth2 only), PV5-11's "verify, then re-fetch"
   rule is essential, not optional: the notice is a trigger, the re-fetch is the truth.
3. **Exit and e-Meterai.** Signed documents are downloadable by API, VIDA also sells e-Meterai stamping
   in the same flow, and VIDA is named by the Ministry of Finance as a PSrE (so the registration is
   corroborated by a second official source).

**Runner-up: Privy.** Largest PSrE by volume, e-Meterai at a published Rp11,998, and a third-party SDK
shows a `document_status` call (a re-fetchable status). It lost on two criteria: the published business
plan is per employee account (a seat model, breaches EST-D-VI1 if staff need accounts), and its API
documentation is not public. It becomes the pick if a written quote shows per-document API pricing with
no employee accounts.

**Peruri and Digisign** publish too little (no price, no API docs) to be picked on evidence; either can be
asked for a quote as a fallback.

---

## 2. Payment gateway (hosted checkout): comparison

**Can Stripe serve an Indonesian merchant?** Not as a general gateway today. Stripe's help centre says it
is available in Indonesia as an **invite-only program**, supports **IDR only** and **bank-transfer
(virtual account) only**, and no other payment methods ([Stripe support](https://support.stripe.com/questions/supported-payment-methods-currencies-and-businesses-for-stripe-accounts-in-indonesia),
read 2026-10-12 via search excerpt). It is therefore not compared further.

### 2.1 Criteria table

| Criterion | **Midtrans** (GoTo Financial) | **DOKU** | **Xendit** |
|---|---|---|---|
| **Hosted checkout, no card data to us** | Yes. Snap token response carries a `redirect_url` to a Midtrans-hosted page ([Snap guide](https://docs.midtrans.com/docs/snap-snap-integration-guide), 2026-10-12) | Yes. `POST /checkout/v1/payment` returns `response.payment.url` ([Backend Integration](https://developers.doku.com/accept-payments/doku-checkout/integration-guide/backend-integration), 2026-10-12) | Yes. Invoice API returns `invoice_url`, but **Invoice is legacy**: Xendit's migration guide steers new work to Payment Sessions (`ps-` ids, `GET /sessions/{id}`), no sunset date given ([migration guide](https://docs.xendit.co/docs/migrate-to-payment-session), 2026-10-12) |
| **VA, QRIS, e-wallet, card** | All. Fees listed for VA (BCA, BRI, Mandiri, BNI, Permata, CIMB, Danamon, BSI, SeaBank), card, QRIS, GoPay, ShopeePay, DANA, OVO, convenience stores, PayLater ([midtrans.com/pricing](https://midtrans.com/pricing), 2026-10-12) | All. Plus installments, direct debit, PayLater ([doku.com/en-US/pricing](https://www.doku.com/en-US/pricing), 2026-10-12) | All. "38+ payment methods" ([xendit.co pricing](https://xendit.co/en-id/pricing/)); see fees |
| **Per-transaction fees only** | Yes: "setting up is free, and you're only charged for successful transactions". **VA Rp4,000; QRIS 0.7%; card 2.9% + Rp2,000; GoPay 2%; DANA/OVO 1.5%; convenience store Rp5,000.** Excludes VAT per the English page (the Indonesian page and the English page disagree on which methods include tax). Payout to bank Rp5,000 per payout | Yes: "No setup fees", "No monthly fees". **VA Rp4,000 (BCA Rp4,500); QRIS 0.7% (0% for Rp0 to 100,000); card 2.8% + Rp2,000; DANA 1.5%; OVO 2% to 3.18%; Indomaret Rp6,500.** Excludes VAT. The same page also shows "$199 per tahun" Starter and Business tiers under placeholder text, so a subscription line may or may not exist | Per the Xendit help centre (search excerpt; the page itself returned 403 to us): no registration, subscription, maintenance, termination or withdrawal fee; **VA (Mandiri, BNI, BRI, Permata, BSI and others) Rp4,000; card 2.9% + Rp2,000; DANA 1.5%**; QRIS shown as 0.63% on one page and 0.70% on another. All excl. 11% VAT except QRIS and ShopeePay |
| **Callback signing** | `signature_key` = SHA512(order_id + status_code + gross_amount + ServerKey), computed by us and compared ([notifications](https://docs.midtrans.com/docs/https-notification-webhooks)) | HMAC-SHA256 over Client-Id, Request-Id, Request-Timestamp, Request-Target and body Digest, header `Signature: HMACSHA256=...`; `Request-Id` is generated "to prevent duplicate notifications" ([best practice](https://jokul.doku.com/docs/docs/http-notification/http-notification-best-practice/)) | A **shared token** in the `x-callback-token` header, compared to the dashboard value. No cryptographic signature described ([webhooks](https://docs.xendit.co/docs/handling-webhooks)) |
| **Status API (design decision 15)** | Yes. Midtrans itself says to confirm with **GET Status** before acting, and that `settlement` can arrive before `pending` ([notifications](https://docs.midtrans.com/docs/https-notification-webhooks)). Success = `settlement` (or `capture` for card) with `fraud_status` `accept` | Yes. A status request `/orders/v1/status/{invoice}` is shown, same signing without a Digest (search excerpt of [signature docs](https://developers.doku.com/get-started-with-doku-api/signature-component/non-snap/signature-component-from-request-header)). The status page itself returned 404; statuses `[UNVERIFIED]` | Yes: `GET /v2/invoices/{id}` (statuses PENDING, PAID, SETTLED, EXPIRED), or `GET /sessions/{id}` (ACTIVE, COMPLETED, EXPIRED, CANCELED). Xendit's webhook page does **not** recommend re-fetching |
| **Duplicates and retries** | Rare duplicates; use `order_id` as the key. Retries up to 5 times at about 2, 10, 30, 90, 210 minutes; respond 200 within 5 seconds | May send the same event more than once; log and skip. Retry schedule not documented | Up to 6 retries with exponential backoff; dedupe on `payment_id` / `capture_id` (no webhook-id header documented) |
| **Amount rules (decision 16)** | `gross_amount` "Integer"; examples whole rupiah. `order_id` unique, **used once**, max 50 characters, `[A-Za-z0-9-_~.]` | `order.amount` integer IDR, no decimals, max 12 chars. `invoice_number` max 64 (30 if card is on). Expiry `payment_due_date` in minutes | Not read |
| **Settlement timing** | **Not found.** Midtrans pages give the `settlement` status but not the payout schedule | **T+1** for VA (other banks), DOKU Wallet and QRIS; cards T+3 (BRI, BNI, Mandiri); not settled until the account is verified; daily 12:00 to 14:00 GMT+7 ([DOKU settlement time](https://docs.doku.com/accept-payments/finance-and-settlement/settlement-time)) | VA mostly instant (BCA T+1 or T+2, sources conflict); QRIS and e-wallets T+2 business days; new merchants may be limited to T+3 or T+7 for the first 2 months ([help centre](https://help.xendit.co/hc/en-us/articles/29558611188633-How-long-is-the-settlement-time-for-Virtual-Account-transactions), search excerpt) |
| **Fee reporting** | Net settlement: VAT is deducted from the fee and the Midtrans balance (Indonesian pricing article). Per-transaction fee report format `[UNVERIFIED]` | Back-office statuses Payment Success, Reconciled, Settled. Fee report format `[UNVERIFIED]` | `GET /transactions` lists fees (search excerpt). Format `[UNVERIFIED]` |
| **Refunds** | Refund API (`/refund`), partial refunds supported; **methods supported: card, GoPay, ShopeePay, DANA, OVO, QRIS, Kredivo, Akulaku. Not virtual account.** May need activation by support ([refund API](https://docs.midtrans.com/reference/refund-transaction)) | Non-card refunds only **after settlement**, only to a bank account or DOKU e-Wallet; shortfall to be paid within 7 business days ([DOKU refund](https://docs.doku.com/accept-payments/finance-and-settlement/refund)) | QRIS refunds limited by issuer (full refunds only within 24 hours for some). Refund fee not found |
| **Sandbox** | Yes. Sandbox hosts `app.sandbox.midtrans.com` documented ([Snap guide](https://docs.midtrans.com/docs/snap-snap-integration-guide)). Whether sandbox needs business verification: not stated | Yes. `api-sandbox.doku.com` shown in the checkout docs. Sandbox account process not found | Yes. Test Mode is available "directly after sign up" with virtual funds, **before** business verification (search excerpt of [create account](https://docs.xendit.co/docs/create-account)) |
| **Exit** | Hosted page and webhooks sit behind our adapter; replacing means a new merchant approval and a new adapter. Our ledger holds payments and receipts | Same | Same, plus the legacy-to-Payment-Sessions migration is a vendor-driven change we would have to absorb |

### 2.2 Pick and runner-up

**Pick: Midtrans.** Reasons, tied to the criteria:

1. **Per-transaction pricing, plainly published.** No setup or monthly fee; VA Rp4,000 and QRIS 0.7% are the
   two rails an Indonesian agency's clients will use most. No seat concept exists.
2. **It is the only one whose own documentation tells integrators to do what design decision 15 requires.**
   A documented signature (SHA-512 over four fields plus the server key), an explicit "confirm with GET
   Status before acting", a documented retry ladder, an explicit idempotency note keyed on `order_id`, and
   the out-of-order warning (`settlement` before `pending`). PV5-10's "verify, claim, re-fetch" maps onto it
   one to one. DOKU's HMAC is stronger as a signature, but its status page was not readable and Xendit does
   not recommend a re-fetch.
3. **Sandbox and checkout are concrete.** Snap `redirect_url` (no card data to us), whole-rupiah
   `gross_amount`, and a documented sandbox host. Xendit's Invoice product is flagged legacy, which is churn
   we should not build on.

Known weaknesses of the pick: virtual-account payments **cannot be refunded through the API**, settlement
timing was not found, and `order_id` is single-use (PV5-10 must mint one `order_id` per checkout attempt,
not reuse the invoice number). Refunds are out of scope for v1 anyway (the ticket's "Not in PV-5" table).

**Runner-up: DOKU.** Strongest callback signing (HMAC with a replay-resistant `Request-Id`), integer-rupiah
amount rule, T+1 settlement documented, sandbox host documented. It lost on a messier public price page
(a placeholder subscription line) and the unreadable status page. If a sales answer shows no subscription
fee, DOKU is a fully acceptable swap and the adapter boundary makes it a 2 to 4 week change.

**Xendit** is acceptable but third: shared-token callbacks, a legacy invoice product, and the pricing page
and help centre pages were unreadable to our fetcher (so its fee table is a search excerpt).

---

## 3. What the owner must do to open a sandbox (describe only; none of it was done)

### 3.1 VIDA (e-signature)

- Contact VIDA sales (`vida.id/sales`, linked from the product page) and ask for **API access and a test
  environment** for VSP OpenAPI. The public docs say clients "request platform access and generate API
  keys"; a sandbox is not mentioned and may need the sales team.
- Ask VIDA's Solution Architect team to **enable webhooks**, and choose Basic or OAuth2 client credentials
  for the callback (the docs say VIDA enables it and the partner shares credentials and the URL).
- Business documents VIDA will ask for at contract stage: **not published** in what was read. Expect
  company legal documents (deed, MoJHR decree, NIB, company NPWP, director KTP) as is usual for a PSrE
  customer `[UNVERIFIED]`.
- Ask in writing: whether the Rp175,000 Business plan is per user; the API unit price per signature; the
  e-Meterai price; certificate cost to the signer; whether a status-query endpoint exists; the webhook
  retry rule.

### 3.2 Midtrans (payment)

- Register at the Midtrans passport page with business name, full name, business email, phone and
  password; confirm the email; the email and phone must not already be linked to a Midtrans, GoBiz or
  GoFood account ([how to register](https://docs.midtrans.com/docs/how-to-register-as-midtrans-merchant)).
- To activate the account ("passport") for a **PT**, upload (from the dashboard banner): latest company
  deed; Ministry of Law and Human Rights decree on the deed; director's KTP or passport; director's NPWP;
  company NPWP; NIB, SIUP or TDP; other licences for the business activity
  ([required documents](https://docs.midtrans.com/docs/what-are-the-legal-documents-required-for-midtrans-account-registration)).
  An older "getting started" page also asks that the business website be public with products and prices
  visible `[UNVERIFIED, older page]`.
- Whether sandbox keys work **before** that verification is not stated. Ask, or expect to complete
  registration first.
- Then in the dashboard: set the Payment Notification URL (HTTPS, reachable from the internet, no auth or
  VPN) to the ERP's `/api/webhooks/payments/midtrans`, set the Finish/Unfinish/Error redirects, and ask
  support to enable the refund API if refunds are wanted later.

### 3.3 If a runner-up is used instead

- **Privy:** "Talk to Sales" for an **API and Custom plan** quote; ask for no employee accounts.
- **DOKU:** register as a Corporate merchant in the Back Office (`dashboard.doku.com/bo/register`);
  corporate (PT) documents are listed in the dashboard, not on the public pages (the public page read
  showed the Malaysian list); DOKU will not settle until the business is verified.

---

## 4. Effect on PV5-10 and PV5-11

- **PV5-10 (Midtrans).** One `order_id` per checkout attempt, at most 50 characters from `A-Za-z0-9-_~.`,
  never reused; store it on `payment_checkouts`. Handler: verify `signature_key`; claim
  `(provider, event_id)` (Midtrans has no event id, so use `order_id` + `transaction_status` +
  `status_code`, or the transaction id, and confirm which in the sandbox); **GET Status**; accept only
  `settlement` (or `capture` for card) with `fraud_status` `accept` if present. Acknowledge 200 within 5
  seconds (use the outbox for the rest). A `settlement` arriving before `pending` must not be ignored as
  "unknown".
- **PV5-11 (VIDA).** The webhook cannot be authenticated by signature, only by shared credential, so the
  re-fetch is the only integrity control. If no status endpoint exists (section 5), the fallback is to
  call the Download Signed Document API on every notice and verify the downloaded PDF's hash and signature
  locally. **If neither works, PV5-11 must be re-scoped before build.** Cost is per external signature,
  so the portal must not create an envelope until the client has actually reached the sign step.
- **A provider that charges per signer per year** would change the "Sign with ..." button into a
  billable step per client; none was found.

---

## 5. Facts not verified (`[UNVERIFIED]`)

1. The **current Komdigi PSrE list** was not read (HTTP 403); the list in section 1.2 is a search excerpt.
2. **PP 71/2019 art. 59 to 60** were read through secondary sources only; whether a newer regulation
   replaced them was not confirmed. **PMK 134/PMK.03/2021** content was read via search summaries; the
   Rp5,000,000 threshold was not found.
3. **No PSrE publishes an API price.** VIDA's per-signature rate (Rp30,000 per 10) is the plan page, not an
   API rate card; its Business plan may or may not be per user.
4. **Privy's** plan prices conflict between sources (Rp225,000 per employee account per month on the
   pages read, Rp175,000 per month in a news summary). Its API docs are behind a login, so signing link,
   webhook, sandbox and certificate download were not confirmed. The `document_status` call comes from a
   third-party SDK.
5. **VIDA:** sandbox availability; a status-query endpoint; certificate download; webhook retry and
   delivery guarantees; certificate cost to the signer; e-Meterai price; the SK 179/2019 reference.
6. **Peruri and Digisign:** price, API terms and sandbox (none public). Digisign's 2026 recognition decree
   is its own claim, not seen on a regulator page.
7. **e-Meterai:** Privy's Rp11,998 came from news excerpts (Bisnis.com's page returned 403). VIDA, Peruri,
   Digisign prices not published.
8. **Midtrans:** settlement timing; fee-report format; whether sandbox needs verification; which pricing
   page governs VAT (English and Indonesian pages disagree); ShopeePay and GoPay figures differ between
   the two pages.
9. **DOKU:** the status-check page (404 on our fetch), status values, retry schedule, whether the
   "$199 per tahun" line is a real subscription, sandbox account steps, PT document list.
10. **Xendit:** pricing page and help-centre pages returned 403; fees are search excerpts; QRIS rate
    conflicts (0.63% vs 0.70%); BCA settlement conflicts (T+1 vs T+2); webhook-signature details for
    Payment Sessions; refund fees.
11. **Exit validity:** whether any PSrE returns OCSP/CRL evidence at signing, and what each does to
    validation endpoints if a customer leaves.
12. **Stripe:** the "invite-only" statement came from a search excerpt of its help page.
