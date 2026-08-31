# Gold-glass port — assessment, change register, and what is left

Status: **IN PROGRESS**. Opened 2026-08-30, this assessment 2026-08-31.
Scope: `platform-ui/` (both shells). Design source: `design/gaiada-erp-gold-glass/`.

This file exists because the port was running as a screenshot-chase: the owner would
spot something, it got patched, and the next thing surfaced. It is the register that
replaces that — what shipped, what enforces it, what is still different, and for each
release the symptom to look for if it turns out to be wrong.

---

## 1. What the design actually is

`design/gaiada-erp-gold-glass/` — two files, exported from Claude Design, built by the
designer against `platform-ui` at `main @ 540870ed`. The IA, sitemap, copy and flows in
it are **ours, verbatim**; see the bundle's own `github.md` for the screen→source map.
**This is a reskin, not a re-architecture.**

It draws **7 screens**: Dashboard, Approvals, Project Management, Department console,
Assistant, The Office, plus Login in its own file. It defines **50 `--fd-*` tokens**.

Two traps in the bundle itself:

- The `_ds/luxury-minimalist-*` folder is **dead weight**. The files link it and consume
  nothing from it. The real contract is the inline `--fd-*` block in each `<style>`.
- `github.md` says "violet accent". **Stale.** The shipped files are gold `#F5D560`.

### Do not copy the design's CSS structure

The mock defines dark in `:root` and derives light from `:has(.fd[data-fd-theme="light"])`.
We do the reverse: light in `:root`, dark under both `@media (prefers-color-scheme: dark)`
and `html[data-theme="dark"]`. **Translate the values into our structure.** Copying the
`:has()` pattern breaks the system-default state, where no attribute is stamped at all.
The two design files do not even agree with each other on this — the dashboard scopes to
`:root`, the login to `.fd`.

---

## 2. Owner decisions

| # | Decision | Consequence |
|---|---|---|
| 1 | **The serif dies.** Urbanist replaces Cormorant Garamond everywhere. | Reverses the 2026-08-22 call. Cormorant's woff2 files are deleted. |
| 2 | **Gold is the accent, bronze stays the brand.** | `--accent` gold; `--brand-color-primary` bronze, so bronze survives in company identity. |
| 3 | **Glass caps at chrome + top-level cards.** | Anything nested reads `--surface-card-solid`. Enforced, not documented. |
| 4 | **Theme default unchanged** (2026-08-31). | The design's own light ground IS cream `#F1EEE5`, so "remove the cream" and "follow the design" conflicted. Owner kept current behaviour. |
| 5 | **UI/UX only.** | No feature, no functionality, nothing removed. Controls may MOVE region; they may not disappear. |

---

## 3. The light-theme divergence, stated plainly

The app is deliberately **more restrained than the artboards in light**, and this is not a
bug to fix casually:

`--accent-fill` is the bright gold `#F5D560`. As TEXT on the cream canvas it measures
**1.30:1**. So light-theme generic `--accent` is the DEEP gold `#7C671D`; the bright tone
appears only as a FILL, always carrying `--ink-on-accent-fill` (`#23200F`, 11.34:1).

Matching the artboards' bright-gold-everywhere look needs a graphic/text split audited
across ~124 `--accent` call sites. That is a decision, not a task.

---

## 4. Change register

Every release, what it touched, and **the symptom to look for if it is wrong**. Revert =
`git revert <release>` unless noted; each is a self-contained commit.

| Release | Changed | If it is wrong, the symptom is |
|---|---|---|
| `Alpha …0195a` | Token layer re-pointed to gold across light root, both dark blocks and the print block. Print path fixed. | Wrong hue app-wide; or a PDF that renders dark. |
| `…0196a` | Glass shell, ambient wash, glass cards. `::before` layers. | Collapsed-rail flyouts appearing in the wrong place (see §6). |
| `…0197a` | Urbanist self-hosted; sentence-case buttons, pill tabs, boxed inputs, 52px rows. | Headings in the body face; or controls reverting to uppercase. |
| `…0198a` | Uppercase sweep — 140 declarations across 33 stylesheets. | Any shouting label. |
| `…0208a` | Client portal onto the design. 58 surfaces → `--surface-card-solid`. | Portal looking like a different product; or a translucent sticky table header. |
| `…0210a` | Re-sweep (10 came back) + **the uppercase guard**. | See §6 — this one recurred once already. |
| `…0301a` | `.erp-main__inner` centred; sidebar glyph on the group row; check-in compact state as a card. | Content hugging the left edge. **This shipped INERT — see 304.** |
| `1.0.0-alpha.303` | ＋New → sidebar floor; account → top bar. Company block un-boxed. Theme pill. Assistant disc. | A menu opening off-screen; a missing create action. |
| `…304` | `DEFAULT_PREFS.width` `wide` → `standard`. | Content full-bleed again, uncentred. |
| `…305` | Sign-in button ink + **the gold-ink guard**. | Unreadable button text on any gold fill. |
| `…306` | Theme label un-clipped; search 420→260px; tagline hidden; company label restyled. | A truncated theme label. |
| `…307` | Brand mark → pulse glyph; collapse control → edge disc. | A missing collapse button (see §6). |

---

## 5. Guards — what is now enforced

`platform-ui/src/styles/tokens.test.ts`, **32 assertions**. The five that came out of this
port:

1. **No colour / radius / shadow literal** in component CSS.
2. **Glass boundary** — `--blur-glass` only in `shell/shell.css`, `portal/portal.css`,
   `ui.css`. Each is a chrome or the card primitive. A fourth entry should be argued.
3. **Print/dark parity** — every token a dark block overrides has a light value under
   print, at a specificity that outranks a pinned dark theme.
4. **No uppercase** anywhere in component CSS.
5. **A gold fill always carries gold ink** — scans `src/app` AND `src/components`.

**Guard coverage gap, now closed:** every guard except #5 scans `src/components` only.
`src/app/login/login.css` sat outside the entire guard surface, which is why the
unreadable sign-in button survived.

---

## 6. What actually bit us — read before touching these

- **`backdrop-filter` creates a containing block for `position: fixed` descendants.**
  `.erp-railmenu` and `.erp-railtip` are fixed and render INSIDE `.erp-side`. Glass must
  stay on a `::before`, never the panel.
- **`.erp-side` has no `overflow: hidden` on purpose.** It would clip
  `.erp-usermenu__pop`, which holds Sign out. The 307 edge-disc collapse control also
  depends on this.
- **A sweep does not survive a merge.** The 0198a uppercase sweep was undone by
  `Merge branch 'main' into reva/ui`, plus two stylesheets written after it in the old
  idiom. Only the guard held.
- **An inline style beats the stylesheet.** `CompanyContext.tsx` carried
  `style={{ fontSize: 9, opacity: 0.5 }}`, which silently won over every restyle attempt.
- **Specificity beat a correct rule.** 0301a's centring was real and inert:
  `.erp-app[data-width="wide"] .erp-main__inner { max-width: none }` outranked it, and
  `wide` was the default. **Verify against a rendered page, not the stylesheet.**
- **Two sessions cutting releases from `main` has cost work twice** — once via the merge
  above, once when the versioning scheme changed to semver mid-task and a malformed tag
  (`alpha-.0001a`) was pushed and had to be deleted and its run cancelled.

---

## 7. Measured adoption — where the port actually stands

**CORRECTION (2026-08-31, same day).** The first version of this section claimed
`/admin` and `/reports` render **zero** cards, measured by counting class names in
HTML fetched over curl. That was wrong, and the error is worth recording because it
is the same shape as the 0301a mistake: *the measurement did not measure what it
claimed to.*

Those routes stream. Curl captured `fb-skeleton` — the `loading.tsx` fallback — and
finished before the suspended content arrived: 12 `self.__next_f.push` chunks against
`/pm`'s 1,971. **A page that has not finished streaming is indistinguishable from a
page with no cards, if all you count is class names.**

Counted from SOURCE instead — files under each route group that use `<Card>`,
`<KpiTile>`, `<HairlineTable>` or `lux-card`:

| Route group | Files using a card primitive | Total pages | Adoption |
|---|---|---|---|
| `hr` | 14 | 14 | 100% |
| `pm` | 1 | 1 | 100% |
| `approvals` | 2 | 2 | 100% |
| `finance` | 17 | 17 | 100% |
| `portal` | 15 | 15 | 100% |
| `admin` | 9 | 10 | **90%** |
| `it` | 9 | 10 | 90% |
| `clients` | 4 | 5 | 80% |
| `departments` | 34 | 45 | 75% |
| `systems` | 4 | 6 | 66% |
| `reports` | 2 | 4 | **50%** |
| `office` | 1 | 2 | 50% |

`admin` is at 90%, not 0%. `reports` is at 50%, not 0%.

**The chrome is universal and primitive adoption is broadly high.** The remaining
surfaces are `reports` (its chart kit is legitimately its own thing), `office`,
`systems` and the long tail of `departments`.

**Lesson for anyone measuring this again:** count from source, or drive a real browser.
An HTTP fetch of a streaming route measures how fast curl gave up.

## 8. Open items

| # | Item | Why it is not done |
|---|---|---|
| 1 | `reports`, `office`, `systems` and the `departments` tail finish adopting the primitive | 50-75% today, not 0% — see the correction in §7. No artboard for any of them; the design draws none of these screens, so completing them is judgement rather than transcription. |
| 2 | The check-in card's inline-input composition | The artboard puts the input and a gold Submit inside one card. Ours renders a different structure with real submit logic behind it; decision 5 says UI/UX only. |
| 3 | Light-theme bright gold | §3. Needs the ~124-site graphic/text audit. |
| 4 | `/pm` returns **39.8 MB** of HTML | Found during this assessment. Not a design issue and not investigated — flagging it because it is by far the largest thing measured here. |
| 5 | Nothing is DEV-VERIFIED | The port is verified as *served CSS* and *rendered markup*. No one has driven the themed UI and looked at it. |

---

## 9. How to check a change, properly

The lesson of 0301a→0304: **the stylesheet being right proves nothing.**

```bash
# 1. Real SSO session (drives /auth/login, not sso-login.sh, which stops at a token
#    and never completes the app callback — so it yields no gaiada_session).
bash erp-session.sh hansel@gaiada.com "$PW" erp.jar

# 2. Rendered markup for the route you changed
curl -sS -b erp.jar -L https://erp.gaiada.online/ -o dash.html

# 3. The CSS that route actually loads (per-route code splitting — the login
#    bundle contains NO shell rules, so it can never verify them)
for f in $(grep -oE '/_next/static/css/[a-zA-Z0-9]+\.css' dash.html | sort -u); do
  curl -sS -b erp.jar "https://erp.gaiada.online$f" >> app.css
done

# 4. Check the ATTRIBUTES the rules key on, not just the rules
grep -oE 'data-width="[a-z]+"' dash.html
```
