// Runtime "post digests back into trial (non-registry) groups" toggle. Mirrors the action
// kill-switch (safety/kill-switch.ts): env (config.postToGroups) sets the boot default,
// setPostToGroups() overrides it at runtime with no redeploy. The digest send path
// (schedule.ts) reads this via postToGroupsEnabled() instead of config.postToGroups
// directly — only relevant when the group registry is inactive (trial mode), since an
// active registry uses each group's own optIn flag instead (see schedule.ts).
import { config } from "../config";

let enabled = config.postToGroups;

export function postToGroupsEnabled(): boolean {
  return enabled;
}

export function setPostToGroups(on: boolean): void {
  enabled = on;
}

/** Test-only reset to the configured boot default. */
export function resetPostToGroups(): void {
  enabled = config.postToGroups;
}
