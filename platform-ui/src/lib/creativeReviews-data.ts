import "server-only";
// DW-6h UI (contract §35.5): server-only readers for asset versions and review rounds. Each returns a `ReadResult`, so a
// refusal or an outage renders as itself and never as an empty list that reads as "no versions" (an empty list is a claim).
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import type { CreativeAsset } from "./creative";
import {
  assetListPath, assetVersionsPath, assetReviewsPath,
  type AssetListOpts, type AssetVersion, type AssetVersionFields, type ReviewRound,
} from "./creativeReviews";

/** The Asset Library list: each asset's LATEST version by default, narrowed to a department's subtree when given. */
export function readCreativeAssets(
  userId: string,
  tenant: string,
  opts: AssetListOpts = {},
): Promise<ReadResult<(CreativeAsset & Partial<AssetVersionFields>)[]>> {
  // A 404 on the list means the endpoint is not served here: today's rule (an empty library), kept.
  return readResult(platformFetch<(CreativeAsset & Partial<AssetVersionFields>)[]>(assetListPath(tenant, opts), userId), { absentAsEmpty: [] });
}

/** The group's live versions, newest first. */
export function readAssetVersions(userId: string, tenant: string, assetId: string): Promise<ReadResult<AssetVersion[]>> {
  return readResult(platformFetch<AssetVersion[]>(assetVersionsPath(tenant, assetId), userId));
}

/** The group's review rounds, newest first. */
export function readAssetReviews(userId: string, tenant: string, assetId: string): Promise<ReadResult<ReviewRound[]>> {
  return readResult(platformFetch<ReviewRound[]>(assetReviewsPath(tenant, assetId), userId));
}
