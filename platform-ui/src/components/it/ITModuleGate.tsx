"use client";
import { usePathname } from "next/navigation";
import { ModuleDisabled } from "@/components/ModuleDisabled";

// P2-14 — the one exemption in the IT console's module gate, and why it has to exist.
//
// ⚠ THE CONTRADICTION THIS RESOLVES. The IT layout gated the WHOLE console on
// `isModuleOnForActiveCompany("it")`, which is right for Devices / Topology / Workflows: those read
// `ItController`, which is `ModuleEnabledGuard("it")`, so with the module off they 404 and would render
// as an empty estate — indistinguishable from a real one.
//
// Accounts is different, deliberately. P2-13's `/api/:t/it/accounts` is NOT module-gated (design §5.4),
// and the reasoning is explicit in that controller: IT provisioning is not an HR-or-IT-module capability,
// and gating it would make login management vanish for a company with the module switched off *while its
// people still need logins*. Leaving Accounts under the blanket gate would have re-imposed, in the UI,
// exactly the restriction the backend was built to avoid — and it would have failed in the reassuring
// direction: "IT module disabled" instead of "three leavers can still log in".
//
// So the gate becomes per-tool rather than per-console. `usePathname` is the only thing a layout can
// reasonably consult for this (a server layout is not handed its own route), and the check is a prefix
// so `/it/accounts` and any future child of it stay exempt.
export function ITModuleGate({ moduleOn, children }: { moduleOn: boolean; children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const exempt = pathname.startsWith("/it/accounts");
  if (moduleOn || exempt) return <>{children}</>;
  return <ModuleDisabled module="it" label="IT" />;
}
