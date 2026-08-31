# Luxury Minimalist Design System

**Language / Bahasa:** **English** (below) · [**Bahasa Indonesia** ↓](#bahasa-indonesia)

A **luxury minimalist** design system for editorial commerce, presentation decks, and refined web surfaces. The system is built to be **color- and asset-agnostic at its core**: every component reads semantic aliases that resolve to editable brand variables, so the entire library can be re-skinned (and re-logoed) live from a single control panel without touching component code.

> This system ships **brand-neutral**. The wordmark token `--brand-logo-text` defaults to **“Logo”** and the footer to `© [YEAR] [BRAND NAME]. All rights reserved.` (year computed live) until you supply your own brand name and/or logo via the Control Panel. There is no hardcoded brand identity — set the brand `--brand-color-*` tokens, `--brand-logo-text`, and `--brand-logo-source`, and the whole library re-renders.

## Sources

This system was generated from a written architectural blueprint plus a set of generic guidance skills (no external codebase or Figma was attached). For provenance, the inputs were:

- **Blueprint** — the detailed luxury-minimalist spec (token panel, logo rules, type scale, spacing OCD rules, component blueprints). This is the source of truth for every measurement below.
- **Guidance skills** (read for tone/quality, not brand specifics): `frontend-design`, `responsive-design`, `scroll-experience`, `design-system`, `microcopy`, `copywriting-psychologist`, `copywriting`, `marketing-psychology`, `seo`, `ui-design-system`, `create-design-system-rules`.
- **Font assets** — Cormorant Garamond (Bold/Regular, `.ttf`) and Inter (Bold/Regular, `.woff`), uploaded and shipped in `assets/fonts/`.

No live product/codebase exists yet, so the **Maison Storefront** UI kit is a faithful, on-system extension (not a recreation of an existing app). If a real product or Figma is added later, build additional UI kits from it as the source of truth.

---

## CONTENT FUNDAMENTALS

The voice is **quiet, assured, editorial** — the confidence of heritage luxury that never raises its voice.

- **Person & address:** Speaks as the maison ("we"), addresses the reader as "you" sparingly and warmly. Never salesy, never urgent.
- **Casing:** Sentence case for body and headings. **Buttons and nav links use Title/Sentence case — never uppercase.** UPPERCASE with `0.10em` tracking is reserved for **eyebrows and badges** only; that restrained tracking is the system's signature editorial gesture.
- **Tone matrix:** ~80% information / 20% warmth by default; closer to 70/30 at human moments (empty states, errors, first contact). Warmth is at most half a sentence, always followed by a clear next step.
- **Microcopy:** Empathetic, never robotic. Errors reassure rather than alarm — e.g. *"We'll only write to confirm your invitation — never anything more."* set in the accent color at 60% opacity, not a red alert.
- **Numerals:** Years render as **plain digits**, computed live (`© 2026 Logo. All rights reserved.`). Prices use the € glyph with thin elegance.
- **Vocabulary:** *Maison, atelier, provenance, edition, commission, stewardship, by appointment, request access.* Scarcity is implied through craft and edition size, never through countdown timers.
- **Emoji:** Never. No emoji anywhere in the brand.
- **Vibe examples:** "An Inheritance, Not a Purchase" · "Considered interfaces shaped by restraint, rhythm and quiet editorial precision."
- **Bilingual preview:** the dashboard carries an **EN / ID toggle** (top-right of the Control Panel). English is the source of truth in the markup; Indonesian comes from a dictionary and is a faithful 1:1 translation — meaning is never rewritten. Technical terms (Body Large, Ghost, Solid, hairline, tracking, Atelier, Maison) and token values stay untranslated.

---

## VISUAL FOUNDATIONS

**Overall:** Restrained, editorial, generous whitespace. The luxury is in the silence between elements.

- **Color:** Warm, low-chroma palette. Premium off-white background (`#F4F1EA`), matte near-black ink (`#1A1916`), a burnished-bronze primary accent (`#6E5A43`), champagne-taupe secondary (`#A39174`). Imagery (when added) should read **warm and natural**, never cool or neon. All editable via the live token panel.
- **Type:** Cormorant Garamond (serif) for all headings H1–H3 — heritage and exclusivity. Inter (sans) for everything functional. Two tracking modes only: normal (`0em`) and wide (`0.10em`).
- **Type scale:** H1 40/60 · H2 32/50 · H3 24/40 · Body Large 18/30 · Body Normal 16/25 · Body Small 14/**25** · Caption 12/**18**. All line-heights are whole integers — never unitless floats.
- **Spacing:** Strict token scale — `10/15/20/30/40/50/60/100`. **No decimals, no odd values, no arbitrary numbers.**
- **Layout law (fluid outer / fixed inner):** every band — header, each section, footer — spans **100% of the viewport** so background tones run edge-to-edge, while their **content is locked to 1340px** and dead-centered by one shared token: `--layout-gutter: max(--section-pad-inline, (100% − 1340px) / 2)`. Gutters step **50px desktop → 40px tablet (≤1024) → 20px mobile (≤768)** by overriding a single variable, so all content edges align on one vertical axis at every breakpoint.
- **Backgrounds:** Solid off-white, paper, tint or ink surfaces — **no gradients on content**, no noise, no texture. Image "plates" in the kit use a single ultra-subtle accent wash purely as a placeholder for real photography.
- **Animation:** Restrained and editorial. `cubic-bezier(0.22, 0.61, 0.36, 1)` easing, 180–520ms. Fades and opacity shifts only — **no bounce, no scale-pop, no infinite loops.** `scroll-behavior: smooth` globally, with a `prefers-reduced-motion` opt-out.
- **Hover states:** Opacity-driven. Ghost buttons fill with accent clamped to ~55% (text inverts to stay legible); solid buttons fade to ~55%; icons rise from 60% to 100% opacity. Never color-shift to a new hue.
- **Nav link states:** default weight 400 at full opacity, no indicator · **hover** stays 400 (no layout shift) and fades in a **1px underline covering 40–50% of the word**, centered · **active/selected** switches to weight 700 with the hover indicator disabled entirely.
- **Press / focus:** Focus shows a thin accent outline at 3px offset. No shrink-on-press; the system stays still and composed.
- **Borders:** Hairlines only — locked to **0.5px**, drawn from the ink color at ~18% opacity. The single divider primitive (`Separator`) is the only rule used anywhere. A `1px` micro-hairline (`--hairline-strong`) exists solely for the scrolled header edge.
- **Shadows:** **None on content.** Depth comes from hairlines and the paper-vs-page surface difference. The **only** shadow in the system is the scrolled header's `--shadow-header` (`0 2px 10px rgba(0,0,0,0.05)`).
- **Corner radii:** **Zero.** Everything is square-edged — buttons, cards, badges, inputs. This squareness is core to the editorial feel; do not round corners.
- **Cards:** **Absolutely borderless** (`border: none; box-shadow: none`) in every context — off-white, accent fill and dark fill alike. Form is defined purely by surface contrast and generous inset: 30px symmetrical padding, 20px grid gap, locked internal rhythm title → 15px → body → 30px → small button. Descriptions are height-equalized per row so all buttons sit on one horizontal axis.
- **Transparency/blur:** Opacity for hover/rest states and hairline tints. `backdrop-filter` is used in exactly two places: the scrolled header (`--blur-glass`, 12px frosted glass) and the mobile drawer scrim (`--blur-overlay`, 2px).
- **Buttons:** heights locked to 40px (Normal, Body Small Bold) and 35px (Small, Caption Bold — mandatory inside cards). Labels never wrap (`white-space: nowrap`), and buttons sharing a row are equalized to the widest label.
- **Layout rules:** Header is a fixed 80px bar; its inner grid is `1fr auto 1fr` so the nav sits in the absolute center. Logo locked to 35px height (matches small button), width auto. Nav rhythm 50–60px between items.

---

## ICONOGRAPHY

- **System:** [Lucide](https://lucide.dev) — thin, consistent 1.5–2px stroke icons that match the minimalist, hairline aesthetic. Loaded from CDN (`unpkg.com/lucide`) in preview pages via `<i data-lucide="…">` + `lucide.createIcons()`. Used for header utilities and footer social links (Facebook / YouTube / Instagram only).
- **Substitution flag:** No bespoke icon set was provided, so Lucide is used as the closest stroke-weight match. **If you have a house icon set, drop the SVGs into `assets/icons/` and swap them in** — this is a substitution, not a brand decision.
- **Dimensions:** Perfect 20×20 square (`--icon-size`). Rest opacity 60%, hover 100% — handled by `.luxury-icon` / `.luxury-icon-btn`.
- **Emoji:** Never used.
- **Unicode as icon:** Only the `←` arrow for back-navigation and `·` as an editorial separator in eyebrow strings. Everything else is a Lucide glyph.
- **Logos:** The wordmark token `--brand-logo-text` defaults to **“Logo”**, set in Cormorant Garamond Bold at 35px line height. Supply a real brand name via the Control Panel (`Brand Name` field) or a logo image (`--brand-logo-source`) — the image is auto-locked to 35px height / auto width in header and footer.

---

## SCROLL & MOTION BEHAVIOR

- **Smart dynamic header:** the `Header` supports `sticky` + `overlay` props. Over an immersive hero it renders transparent with light (off-white) logo/nav/button; past 20px of scroll an `.is-scrolled` class transitions the bar to translucent off-white (92%) with `--blur-glass` (12px) frosted backdrop, the `--shadow-header` micro-shadow, and inner content inverted to off-black. Locked to 80px height, 1340px inner content, 300ms ease-in-out.
- **Sticky-parallax hero:** `.luxury-hero` pins at `top: 0` (z-1) while `.luxury-sections-below` (z-2) slides up and stacks over it like an editorial curtain reveal. `.luxury-hero--full-bleed` breaks out to the full viewport width; hero text is flex-centered in the area below the 80px header so the space above and below the block is mathematically identical.
- **Section tone alternation (zebra):** full-bleed bands alternate via `.section-tone--paper` (off-white), `.section-tone--tint` (muted secondary wash, AAA-contrast dark text), and `.section-tone--dark` (matte ink immersive layer, light text). Content stays centered to the 1340px boundary.
- **Footer anchoring:** the footer ignores the zebra rhythm and is locked to off-white (`.section-tone--paper`), so the scrolled top nav and the footer bookend the page under one color.
- **Mobile drawer (≤1024px):** the horizontal nav collapses into a raw hamburger (no circular container) in the right slot. The drawer is `position: fixed`, full `100vh`, `--drawer-width` (300px; 320px on small phones), off-white, `z-index: 9999` — fully isolated from header clipping. Its close (✕) sits at the **exact same coordinates as the hamburger** for thumb-driven ergonomics, a dimming scrim closes it on click, and body scroll is locked while open. Hero CTAs stack vertically full-width with a 15px gap.

---

## INDEX — Repository Manifest

**Root**
- `styles.css` — global entry; `@import` manifest only (consumers link this one file).
- `Luxury Minimalist Design System.html` — **the live token dashboard.** Control panel (EN/ID toggle, brand name, primary / secondary / bg / text, logo upload) over a full component showcase. Bundle-free; opens anywhere.
- `preview-chrome.css` — dashboard shell styles only; **deliberately not** imported by `styles.css`, so no preview chrome ships to consumers.
- `thumbnail.html` — the design system's homepage tile (brand mark + swatch strip).
- `design-tokens.json` — all tokens in W3C / Tokens Studio format, for importing into Figma as Variables.
- `readme.md` — this guide · `SKILL.md` — Agent-Skills entry for use in Claude Code.

**`tokens/`** — CSS custom properties (3-tier: primitive → brand → semantic), 85 tokens
- `fonts.css` · `colors.css` · `typography.css` · `spacing.css` (spacing, canvas geometry, `--layout-gutter`, elevation/blur, component dimensions, motion)

**`components/`** — reusable React primitives (`.jsx` + `.d.ts` + `.prompt.md` + `@dsCard` html)
- `core/` — **Button**, **Card**, **Badge**, **Separator**
- `forms/` — **FloatingInput**
- `navigation/` — **Header**, **Footer**
- `components.css` — shippable, token-driven component styles + states + the responsive engine (imported by `styles.css`)

**`ui_kits/maison/`** — click-through luxury storefront (Home → Product → Request Access)
- `index.html` · `Storefront.jsx` · `ProductDetail.jsx` · `AccessScreen.jsx` · `data.jsx`

**`guidelines/`** — foundation specimen cards (Design System tab)
- Colors: `colors-brand`, `colors-surface` · Type: `type-display`, `type-body`, `type-tracking` · Spacing: `spacing-scale`, `spacing-dimensions`, `spacing-canvas`

**`assets/fonts/`** — Cormorant Garamond + Inter binaries.

> **Namespace for `@dsCard` HTML:** `window.KALMRDesignSystem_c156e5` (an auto-generated internal identifier derived from an earlier project name — not user-facing branding; rename the project to regenerate it).

---
---

# Bahasa Indonesia

*Terjemahan setia dari dokumen di atas. Istilah teknis dan nilai token sengaja tidak diterjemahkan agar maknanya tetap presisi.*

Sebuah design system **luxury minimalist** untuk commerce editorial, dek presentasi, dan permukaan web yang halus. Sistem ini dibangun agar **netral terhadap warna dan aset di intinya**: setiap komponen membaca alias semantik yang mengarah ke variabel brand yang dapat diedit, sehingga seluruh library bisa diganti tampilan (dan logonya) secara langsung dari satu panel kontrol tanpa menyentuh kode komponen.

> Sistem ini dikirim **netral-brand**. Token wordmark `--brand-logo-text` bernilai bawaan **“Logo”** dan footer `© [TAHUN] [NAMA BRAND]. Hak cipta dilindungi.` (tahun dihitung otomatis) sampai Anda mengisi nama brand dan/atau logo sendiri melalui Panel Kontrol. Tidak ada identitas brand yang di-hardcode — atur token `--brand-color-*`, `--brand-logo-text`, dan `--brand-logo-source`, maka seluruh library ter-render ulang.

## SUMBER

Sistem ini dibuat dari sebuah blueprint arsitektur tertulis ditambah sekumpulan panduan umum (tidak ada codebase eksternal atau Figma yang dilampirkan). Untuk kejelasan asal-usul, masukannya adalah:

- **Blueprint** — spesifikasi luxury-minimalist yang detail (panel token, aturan logo, skala tipografi, aturan spacing ketat, blueprint komponen). Ini adalah sumber kebenaran untuk setiap ukuran di bawah.
- **Panduan** (dibaca untuk nada/kualitas, bukan spesifik brand): `frontend-design`, `responsive-design`, `scroll-experience`, `design-system`, `microcopy`, `copywriting-psychologist`, `copywriting`, `marketing-psychology`, `seo`, `ui-design-system`, `create-design-system-rules`.
- **Aset font** — Cormorant Garamond (Bold/Regular, `.ttf`) dan Inter (Bold/Regular, `.woff`), diunggah dan dikirim di `assets/fonts/`.

Belum ada produk/codebase nyata, sehingga UI kit **Maison Storefront** adalah perluasan yang setia pada sistem (bukan rekreasi aplikasi yang sudah ada). Jika nanti ada produk atau Figma nyata, bangun UI kit tambahan darinya sebagai sumber kebenaran.

---

## FONDASI KONTEN

Suaranya **tenang, yakin, editorial** — keyakinan kemewahan warisan yang tak pernah meninggikan nada.

- **Sudut pandang & sapaan:** Berbicara sebagai maison ("kami"), menyapa pembaca dengan "Anda" secara hemat dan hangat. Tidak pernah menjual keras, tidak pernah mendesak.
- **Kapitalisasi:** Sentence case untuk body dan judul. **Tombol dan tautan navigasi memakai Title/Sentence case — tidak pernah huruf besar semua.** HURUF BESAR dengan tracking `0.10em` khusus untuk **eyebrow dan badge** saja; tracking yang terkendali itu adalah tanda tangan editorial sistem ini.
- **Matriks nada:** ~80% informasi / 20% kehangatan secara default; mendekati 70/30 pada momen manusiawi (keadaan kosong, galat, kontak pertama). Kehangatan maksimal setengah kalimat, selalu diikuti langkah berikut yang jelas.
- **Microcopy:** Empatik, tidak pernah kaku seperti robot. Pesan galat menenangkan, bukan mengejutkan — mis. *"Kami hanya akan menulis untuk mengonfirmasi undangan Anda — tidak lebih dari itu."* memakai warna aksen pada opasitas 60%, bukan peringatan merah.
- **Angka:** Tahun ditulis sebagai **angka biasa**, dihitung otomatis (`© 2026 Logo. Hak cipta dilindungi.`). Harga memakai simbol € dengan keanggunan tipis.
- **Kosakata:** *Maison, atelier, asal-usul, edisi, komisi, pemeliharaan, dengan perjanjian, minta akses.* Kelangkaan disiratkan melalui kriya dan ukuran edisi, tidak pernah melalui hitungan waktu.
- **Emoji:** Tidak pernah. Tidak ada emoji di mana pun dalam brand ini.
- **Contoh nuansa:** "Sebuah Warisan, Bukan Sebuah Pembelian" · "Antarmuka yang dipikirkan matang, dibentuk oleh keterkendalian, ritme, dan ketepatan editorial yang tenang."
- **Pratinjau dua bahasa:** dashboard memiliki **toggle EN / ID** (kanan atas Panel Kontrol). Bahasa Inggris adalah sumber kebenaran di markup; bahasa Indonesia berasal dari kamus dan merupakan terjemahan setia 1:1 — makna tidak pernah diubah. Istilah teknis (Body Large, Ghost, Solid, hairline, tracking, Atelier, Maison) dan nilai token tetap tidak diterjemahkan.

---

## FONDASI VISUAL

**Secara keseluruhan:** Terkendali, editorial, ruang kosong yang lapang. Kemewahannya ada pada keheningan di antara elemen.

- **Warna:** Palet hangat berkroma rendah. Latar putih gading premium (`#F4F1EA`), tinta matte mendekati hitam (`#1A1916`), aksen primer bronze terbakar (`#6E5A43`), sekunder champagne-taupe (`#A39174`). Citra (bila ditambahkan) harus terasa **hangat dan alami**, tidak pernah dingin atau neon. Semua dapat diedit melalui panel token langsung.
- **Tipografi:** Cormorant Garamond (serif) untuk semua judul H1–H3 — warisan dan eksklusivitas. Inter (sans) untuk segala hal fungsional. Hanya dua mode tracking: normal (`0em`) dan lebar (`0.10em`).
- **Skala tipografi:** H1 40/60 · H2 32/50 · H3 24/40 · Body Large 18/30 · Body Normal 16/25 · Body Small 14/**25** · Caption 12/**18**. Semua line-height berupa bilangan bulat — tidak pernah angka desimal tanpa satuan.
- **Spacing:** Skala token yang ketat — `10/15/20/30/40/50/60/100`. **Tanpa desimal, tanpa angka ganjil, tanpa nilai sembarang.**
- **Hukum layout (luar fluid / dalam terkunci):** setiap pita — header, tiap section, footer — membentang **100% lebar viewport** sehingga warna latar mencapai tepi layar, sementara **kontennya terkunci di 1340px** dan terpusat sempurna oleh satu token bersama: `--layout-gutter: max(--section-pad-inline, (100% − 1340px) / 2)`. Gutter berubah **50px desktop → 40px tablet (≤1024) → 20px mobile (≤768)** hanya dengan menimpa satu variabel, sehingga semua tepi konten sejajar pada satu sumbu vertikal di setiap breakpoint.
- **Latar:** Permukaan putih gading, paper, tint, atau tinta yang solid — **tanpa gradien pada konten**, tanpa noise, tanpa tekstur. "Plate" gambar di UI kit memakai satu sapuan aksen amat halus, murni sebagai placeholder untuk fotografi nyata.
- **Animasi:** Terkendali dan editorial. Easing `cubic-bezier(0.22, 0.61, 0.36, 1)`, 180–520ms. Hanya fade dan pergeseran opasitas — **tanpa bounce, tanpa scale-pop, tanpa loop tak berujung.** `scroll-behavior: smooth` secara global, dengan pengecualian `prefers-reduced-motion`.
- **Status hover:** Digerakkan opasitas. Tombol ghost terisi aksen yang dibatasi ~55% (teks membalik agar tetap terbaca); tombol solid memudar ke ~55%; ikon naik dari opasitas 60% ke 100%. Tidak pernah berganti ke warna baru.
- **Status tautan navigasi:** default weight 400 pada opasitas penuh, tanpa indikator · **hover** tetap 400 (tanpa pergeseran layout) dan memunculkan **garis bawah 1px selebar 40–50% dari kata**, terpusat · **aktif/terpilih** berubah ke weight 700 dengan indikator hover dimatikan sepenuhnya.
- **Tekan / fokus:** Fokus menampilkan garis luar aksen tipis dengan offset 3px. Tidak menyusut saat ditekan; sistem tetap tenang dan mantap.
- **Border:** Hanya hairline — terkunci di **0.5px**, dari warna tinta pada opasitas ~18%. Primitif pemisah tunggal (`Separator`) adalah satu-satunya garis yang dipakai. Hairline `1px` (`--hairline-strong`) hanya ada untuk tepi header saat ter-scroll.
- **Shadow:** **Tidak ada pada konten.** Kedalaman berasal dari hairline dan perbedaan permukaan paper vs halaman. Satu-satunya shadow dalam sistem adalah `--shadow-header` pada header ter-scroll (`0 2px 10px rgba(0,0,0,0.05)`).
- **Radius sudut:** **Nol.** Semuanya bersudut siku — tombol, kartu, badge, input. Kesikuan ini inti dari rasa editorial; jangan membulatkan sudut.
- **Kartu:** **Sepenuhnya tanpa border** (`border: none; box-shadow: none`) dalam segala konteks — baik putih gading, isian aksen, maupun isian gelap. Bentuk ditegaskan murni oleh kontras permukaan dan inset yang lapang: padding simetris 30px, jarak grid 20px, ritme internal terkunci judul → 15px → body → 30px → tombol kecil. Tinggi deskripsi disamakan per baris agar semua tombol duduk pada satu sumbu horizontal.
- **Transparansi/blur:** Opasitas untuk status hover/istirahat dan rona hairline. `backdrop-filter` dipakai tepat di dua tempat: header ter-scroll (`--blur-glass`, kaca beku 12px) dan scrim drawer mobile (`--blur-overlay`, 2px).
- **Tombol:** tinggi terkunci di 40px (Normal, Body Small Bold) dan 35px (Kecil, Caption Bold — wajib di dalam kartu). Label tidak pernah turun baris (`white-space: nowrap`), dan tombol dalam satu baris disamakan lebarnya mengikuti label terpanjang.
- **Aturan layout:** Header adalah bilah tetap 80px; grid dalamnya `1fr auto 1fr` sehingga navigasi berada tepat di tengah. Logo terkunci pada tinggi 35px (sama dengan tombol kecil), lebar otomatis. Ritme navigasi 50–60px antar item.

---

## IKONOGRAFI

- **Sistem:** [Lucide](https://lucide.dev) — ikon bergaris tipis konsisten 1,5–2px yang cocok dengan estetika minimalis dan hairline. Dimuat dari CDN (`unpkg.com/lucide`) di halaman pratinjau melalui `<i data-lucide="…">` + `lucide.createIcons()`. Dipakai untuk utilitas header dan tautan sosial footer (hanya Facebook / YouTube / Instagram).
- **Penanda substitusi:** Tidak ada set ikon khusus yang diberikan, jadi Lucide dipakai sebagai padanan ketebalan garis terdekat. **Jika Anda punya set ikon sendiri, letakkan SVG-nya di `assets/icons/` lalu tukar** — ini substitusi, bukan keputusan brand.
- **Dimensi:** Persegi sempurna 20×20 (`--icon-size`). Opasitas istirahat 60%, hover 100% — ditangani oleh `.luxury-icon` / `.luxury-icon-btn`.
- **Emoji:** Tidak pernah dipakai.
- **Unicode sebagai ikon:** Hanya tanda `←` untuk navigasi kembali dan `·` sebagai pemisah editorial pada string eyebrow. Sisanya adalah glif Lucide.
- **Logo:** Token wordmark `--brand-logo-text` bernilai bawaan **“Logo”**, diset dalam Cormorant Garamond Bold pada line-height 35px. Isikan nama brand nyata melalui Panel Kontrol (kolom `Nama Brand`) atau gambar logo (`--brand-logo-source`) — gambar otomatis terkunci pada tinggi 35px / lebar otomatis di header dan footer.

---

## PERILAKU SCROLL & GERAK

- **Header dinamis cerdas:** `Header` mendukung prop `sticky` + `overlay`. Di atas hero yang imersif ia tampil transparan dengan logo/nav/tombol terang (putih gading); setelah melewati 20px scroll, kelas `.is-scrolled` mengubah bilah menjadi putih gading semi-transparan (92%) dengan latar kaca beku `--blur-glass` (12px), shadow mikro `--shadow-header`, dan konten dalam berbalik ke hitam pudar. Terkunci pada tinggi 80px, konten dalam 1340px, transisi 300ms ease-in-out.
- **Hero sticky-parallax:** `.luxury-hero` tertahan di `top: 0` (z-1) sementara `.luxury-sections-below` (z-2) meluncur naik dan menumpuk di atasnya seperti tirai editorial yang terbuka. `.luxury-hero--full-bleed` menembus ke lebar penuh viewport; teks hero terpusat secara flex di area bawah header 80px sehingga jarak atas dan bawah blok tersebut identik secara matematis.
- **Pergantian nada section (zebra):** pita full-bleed bergantian melalui `.section-tone--paper` (putih gading), `.section-tone--tint` (sapuan sekunder lembut, teks gelap berkontras AAA), dan `.section-tone--dark` (lapisan imersif tinta matte, teks terang). Konten tetap terpusat pada batas 1340px.
- **Penambatan footer:** footer mengabaikan ritme zebra dan terkunci pada putih gading (`.section-tone--paper`), sehingga navigasi atas (saat ter-scroll) dan footer mengapit halaman dalam satu warna.
- **Drawer mobile (≤1024px):** navigasi horizontal melipat menjadi hamburger polos (tanpa wadah bulat) di slot kanan. Drawer memakai `position: fixed`, `100vh` penuh, `--drawer-width` (300px; 320px pada ponsel kecil), putih gading, `z-index: 9999` — sepenuhnya terisolasi dari pemotongan header. Tombol tutup (✕) berada pada **koordinat yang persis sama dengan hamburger** demi ergonomi jempol, scrim peredup menutupnya saat diklik, dan scroll body terkunci selama terbuka. CTA hero menumpuk vertikal selebar penuh dengan jarak 15px.

---

## INDEKS — Manifes Repositori

**Akar**
- `styles.css` — pintu masuk global; hanya manifes `@import` (pengguna menautkan satu file ini).
- `Luxury Minimalist Design System.html` — **dashboard token langsung.** Panel kontrol (toggle EN/ID, nama brand, primer / sekunder / latar / teks, unggah logo) di atas peragaan komponen lengkap. Tanpa bundle; bisa dibuka di mana saja.
- `preview-chrome.css` — gaya khusus rangka dashboard; **sengaja tidak** diimpor oleh `styles.css`, sehingga tidak ada chrome pratinjau yang terkirim ke pengguna.
- `thumbnail.html` — tile halaman utama design system (tanda brand + strip swatch).
- `design-tokens.json` — seluruh token dalam format W3C / Tokens Studio, untuk diimpor ke Figma sebagai Variables.
- `readme.md` — panduan ini · `SKILL.md` — entri Agent-Skills untuk dipakai di Claude Code.

**`tokens/`** — properti kustom CSS (3 tingkat: primitive → brand → semantic), 85 token
- `fonts.css` · `colors.css` · `typography.css` · `spacing.css` (spacing, geometri kanvas, `--layout-gutter`, elevasi/blur, dimensi komponen, gerak)

**`components/`** — primitif React pakai-ulang (`.jsx` + `.d.ts` + `.prompt.md` + html `@dsCard`)
- `core/` — **Button**, **Card**, **Badge**, **Separator**
- `forms/` — **FloatingInput**
- `navigation/` — **Header**, **Footer**
- `components.css` — gaya komponen berbasis token yang dikirim ke pengguna + status + mesin responsif (diimpor oleh `styles.css`)

**`ui_kits/maison/`** — storefront mewah yang bisa diklik (Beranda → Produk → Minta Akses)
- `index.html` · `Storefront.jsx` · `ProductDetail.jsx` · `AccessScreen.jsx` · `data.jsx`

**`guidelines/`** — kartu spesimen fondasi (tab Design System)
- Warna: `colors-brand`, `colors-surface` · Tipografi: `type-display`, `type-body`, `type-tracking` · Spacing: `spacing-scale`, `spacing-dimensions`, `spacing-canvas`

**`assets/fonts/`** — biner Cormorant Garamond + Inter.

> **Namespace untuk HTML `@dsCard`:** `window.KALMRDesignSystem_c156e5` (pengenal internal yang dibuat otomatis dari nama proyek sebelumnya — bukan branding yang terlihat pengguna; ganti nama proyek untuk membuatnya ulang).
