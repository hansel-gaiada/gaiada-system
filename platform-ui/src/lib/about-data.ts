import "server-only";
import { platformFetch } from "./platform";
import type { AboutInfo } from "./about";
import { demoModeRequested } from "./demoMode";

// Server-only reader half of lib/about.ts (see that file for why the split exists).

/** The UI's OWN build identity. Read from the process env, which compose feeds from the same
 *  APP_VERSION deploy.yml derives from /VERSION — so ui and platform disagreeing is a real,
 *  visible signal that one container is stale, not a display bug. */
export function uiBuild(): { version: string; node: string; next: string } {
  return {
    version: process.env.APP_VERSION?.trim() || "unknown",
    node: process.version,
    // Next doesn't expose its version on `process`; this is stamped by the framework at build.
    next: process.env.NEXT_RUNTIME_VERSION?.trim() || nextVersion(),
  };
}

function nextVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("next/package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}

/** Runtime switches that change how this deployment behaves. Booleans only — never a secret, and
 *  never the value of a token or URL. */
export function uiFlags(): { label: string; on: boolean }[] {
  const on = (v: string | undefined) => v === "1" || v === "true";
  return [
    // Raw request, deliberately: this panel must show the flag AS CONFIGURED, even in a runtime
    // where serving fixtures is forbidden — otherwise a misconfigured deployment hides its own cause.
    { label: "Demo mode", on: demoModeRequested() },
    { label: "Shared-service assignments", on: on(process.env.SERVICE_ASSIGNMENTS_ENABLED) },
    { label: "Print stub", on: on(process.env.PRINT_STUB) },
    { label: "Telemetry (OTel)", on: on(process.env.OTEL_ENABLED) },
    { label: "OIDC configured", on: Boolean(process.env.OIDC_AUTH_URL) },
  ];
}

/** Platform + downstream service build identities. Elevated-only on the backend; a non-admin or an
 *  unreachable platform yields null so the page renders its degraded state instead of throwing. */
export async function getAbout(userId: string): Promise<AboutInfo | null> {
  try {
    return await platformFetch<AboutInfo>("/api/admin/about", userId);
  } catch {
    return null;
  }
}
