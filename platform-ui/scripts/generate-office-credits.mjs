#!/usr/bin/env node
// Generates src/lib/office-credits.generated.ts from the LPC project's own CREDITS.csv.
//
// Why this exists: legal/asset-licences.md requires "a credits surface... generated from the
// repo's own credit data, not hand-maintained, because a hand-maintained list silently rots." This
// script is that generator. It never commits CREDITS.csv itself (the file is ~4 MB and not ours to
// vendor) — it fetches a fresh copy from GitHub every run, so the credits page can never drift from
// upstream without someone noticing (a licence change upstream would change what this emits, which
// is the point).
//
// Run: `npm run gen:office-credits` (from platform-ui/). Requires network access to
// raw.githubusercontent.com; pass a local path via CREDITS_CSV_PATH to skip the fetch instead.
//
// IMPORTANT: VARIANT_PATHS below must match src/lib/office-sprites.ts's LAYER_PATHS. They are kept
// as two separate literal lists on purpose — this script runs under plain Node with no bundler and
// no TypeScript, so it cannot import a .ts module. A mismatch here means the credits page and the
// shipped sprites disagree, which is a build-time review concern, not something worth adding a
// TS-to-JS build step to prevent.

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CREDITS_URL =
  "https://raw.githubusercontent.com/liberatedpixelcup/Universal-LPC-Spritesheet-Character-Generator/master/CREDITS.csv";
const LPC_REPO_BLOB =
  "https://github.com/liberatedpixelcup/Universal-LPC-Spritesheet-Character-Generator/blob/master/spritesheets";

// The 12 verified variant folders — see src/lib/office-sprites.ts LAYER_PATHS for the same list,
// structured as gendered outfits rather than a flat array.
const VARIANT_PATHS = [
  "body/bodies/male",
  "body/bodies/female",
  "head/heads/human/male",
  "head/heads/human/female",
  "hair/buzzcut/adult",
  "hair/bob/adult",
  "torso/clothes/longsleeve/longsleeve/male",
  "torso/clothes/longsleeve/longsleeve/female",
  "legs/formal/male",
  "legs/formal/thin",
  "feet/shoes/basic/male",
  "feet/shoes/basic/thin",
];

const POSES = ["walk", "sit"];

// Election order per legal/asset-licences.md: "we elect OGA-BY 3.0 wherever it is offered, and CC0
// where that is offered." Both avoid share-alike; if a shipped file offered neither, that would be
// a licence-manifest regression, so this throws rather than silently falling back to CC-BY-SA.
const ELECTABLE_LICENCES = ["OGA-BY 3.0", "CC0"];

function electLicence(licencesField, file) {
  const offered = licencesField.split(",").map((s) => s.trim()).filter(Boolean);
  for (const candidate of ELECTABLE_LICENCES) {
    if (offered.includes(candidate)) return candidate;
  }
  throw new Error(
    `${file}: none of ${JSON.stringify(ELECTABLE_LICENCES)} offered (row offers ${JSON.stringify(offered)}). ` +
      `This file is not electable share-alike-free and must not ship — see legal/asset-licences.md.`,
  );
}

/** Minimal RFC4180 CSV parser — CREDITS.csv rows contain commas and quotes inside quoted fields
 *  (author lists, URL lists), so a naive split(",") corrupts data. No dependency added; this is a
 *  build-time-only script, not shipped to the browser. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

async function loadCreditsCsv() {
  const localPath = process.env.CREDITS_CSV_PATH;
  if (localPath) {
    console.log(`Reading CREDITS.csv from local path: ${localPath}`);
    return readFile(localPath, "utf8");
  }
  console.log(`Fetching CREDITS.csv from ${CREDITS_URL}`);
  const res = await fetch(CREDITS_URL);
  if (!res.ok) throw new Error(`Failed to fetch CREDITS.csv: ${res.status} ${res.statusText}`);
  return res.text();
}

async function main() {
  const csvText = await loadCreditsCsv();
  const rows = parseCsv(csvText);
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));

  const targetFiles = new Set();
  for (const variant of VARIANT_PATHS) for (const pose of POSES) targetFiles.add(`${variant}/${pose}.png`);

  const byFile = new Map();
  for (const row of rows.slice(1)) {
    const filename = row[idx.filename];
    if (targetFiles.has(filename)) byFile.set(filename, row);
  }

  const missing = [...targetFiles].filter((f) => !byFile.has(f));
  if (missing.length > 0) {
    throw new Error(`CREDITS.csv is missing rows for: ${missing.join(", ")} — the shipped file set no longer matches upstream.`);
  }

  const entries = [...targetFiles].sort().map((file) => {
    const row = byFile.get(file);
    const authors = row[idx.authors].split(",").map((s) => s.trim()).filter(Boolean);
    const licence = electLicence(row[idx.licenses], file);
    return { file, authors, licence, url: `${LPC_REPO_BLOB}/${file}` };
  });

  const allAuthors = [...new Set(entries.flatMap((e) => e.authors))].sort((a, b) => a.localeCompare(b));

  const header_ =
    `// GENERATED by scripts/generate-office-credits.mjs — do not hand-edit.\n` +
    `// Run \`npm run gen:office-credits\` from platform-ui/ to regenerate against a fresh CREDITS.csv.\n` +
    `// Source project: https://github.com/liberatedpixelcup/Universal-LPC-Spritesheet-Character-Generator\n` +
    `// Generated at: ${new Date().toISOString()}\n\n`;

  const body =
    `export interface OfficeCreditEntry {\n` +
    `  file: string;\n` +
    `  authors: string[];\n` +
    `  licence: string;\n` +
    `  url: string;\n` +
    `}\n\n` +
    `/** The 24 shipped LPC sprite files, one entry per file, licence ELECTED per\n` +
    ` *  legal/asset-licences.md (OGA-BY 3.0 preferred, CC0 otherwise — never CC-BY-SA). */\n` +
    `export const OFFICE_CREDITS: OfficeCreditEntry[] = ${JSON.stringify(entries, null, 2)};\n\n` +
    `/** Every distinct contributing artist across the shipped set, sorted. */\n` +
    `export const OFFICE_CREDIT_AUTHORS: string[] = ${JSON.stringify(allAuthors, null, 2)};\n`;

  const outPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "lib",
    "office-credits.generated.ts",
  );
  await writeFile(outPath, header_ + body, "utf8");
  console.log(`Wrote ${entries.length} credit entries (${allAuthors.length} authors) to ${outPath}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
