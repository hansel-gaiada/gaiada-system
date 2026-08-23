// Hand-written presentation grouping over the GENERATED credit facts in
// office-credits.generated.ts. This file adds no facts of its own — it only groups the two
// per-pose rows (…/walk.png, …/sit.png) that every shipped asset has into one readable row, and
// throws if a future regeneration ever finds them disagreeing on licence (which would mean the
// asset needs a human look, not a silent merge).
import { OFFICE_CREDITS, OFFICE_CREDIT_AUTHORS, type OfficeCreditEntry } from "./office-credits.generated";

export { OFFICE_CREDIT_AUTHORS };

export interface OfficeAssetCredit {
  /** The LPC variant folder, e.g. "body/bodies/male" — one asset, two files (walk.png, sit.png). */
  asset: string;
  authors: string[];
  licence: string;
  /** Folder-level link into the LPC source repo. */
  url: string;
}

function assetOf(file: string): string {
  return file.replace(/\/(walk|sit)\.png$/, "");
}

const byAsset = new Map<string, OfficeCreditEntry[]>();
for (const entry of OFFICE_CREDITS) {
  const asset = assetOf(entry.file);
  if (!byAsset.has(asset)) byAsset.set(asset, []);
  byAsset.get(asset)!.push(entry);
}

export const OFFICE_ASSET_CREDITS: OfficeAssetCredit[] = [...byAsset.entries()]
  .map(([asset, entries]) => {
    const licences = new Set(entries.map((e) => e.licence));
    if (licences.size > 1) {
      throw new Error(
        `${asset}: its files elected different licences (${[...licences].join(", ")}) — this needs a ` +
          `human look before the credits page ships, not a silent merge.`,
      );
    }
    const authors = [...new Set(entries.flatMap((e) => e.authors))].sort((a, b) => a.localeCompare(b));
    return { asset, authors, licence: entries[0].licence, url: assetOf(entries[0].url) };
  })
  .sort((a, b) => a.asset.localeCompare(b.asset));
