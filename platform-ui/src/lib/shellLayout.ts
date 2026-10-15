// DW-1d: the per-person pilot switch between today's shell ("classic") and the department workspace
// shell ("workspaces", built in DW-2). DW-D7: a pilot week on this switch, then on for everyone, and
// the classic layout removed two releases later (DW-9d). DW-9d-1 made "workspaces" the default for
// everyone; a person who CHOSE classic (the avatar menu) keeps it until DW-9d-2 removes classic.
//
// Stored in the `gaiada_prefs` cookie with density, width and theme (`lib/prefs.ts`), so it is per
// person per browser. Pure and client-safe, so the client shell can read the type.

export const SHELL_LAYOUTS = ["classic", "workspaces"] as const;
export type ShellLayout = (typeof SHELL_LAYOUTS)[number];
export const DEFAULT_SHELL_LAYOUT: ShellLayout = "workspaces";

/** Anything that is not a known layout (a stale or hand-edited cookie, a forged action argument)
 *  reads as the default. */
export function parseShellLayout(raw: unknown): ShellLayout {
  return (SHELL_LAYOUTS as readonly unknown[]).includes(raw) ? (raw as ShellLayout) : DEFAULT_SHELL_LAYOUT;
}
