// WSK-41 — DEV-MODE STUB ONLY (bound when NODE_ENV=test; see ../control.module.ts). It reads an
// UNVERIFIED header, exactly as WSK-21's DevModeControlChannelAuthenticator reads
// x-webdesk-control-principal: nothing here is signed, bound to the arguments, or single-use. WSK-40
// replaces it in every other environment with the Ed25519 assertion verifier (design §5).
//
// Header `x-webdesk-editorial-principal`, one of:
//   - a bare subject:   "user-123"                     -> { sub: "user-123", pk: "human" }
//   - a JSON object:    {"sub":"bot-1","pk":"agent","agt":"webdev-writer","req":"user-9","apr":"…"}
//     (WSK-49b: plus an optional boolean "ce", the client-editor marker the signed assertion carries;
//      M5-W1e: and an optional boolean "xc", the contributor marker, never together with "ce")
// Missing or unusable -> 401 editorial-assertion-missing / -malformed, the same slugs the real
// verifier uses, so a test written against this stub asserts the real contract's refusal shapes.
import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { CommandName } from "../command-types";
import type { ControlRequest } from "./control-request";
import { EDITORIAL_PRINCIPAL_KINDS, type EditorialPrincipal, type EditorialPrincipalResolver } from "./editorial-principal";
import { ControlProblem } from "../content/content-problem";

export const DEV_EDITORIAL_PRINCIPAL_HEADER = "x-webdesk-editorial-principal";

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function malformed(detail: string): ControlProblem {
  return new ControlProblem(401, "editorial-assertion-malformed", "Editorial assertion malformed", detail);
}

@Injectable()
export class DevModeEditorialPrincipalResolver implements EditorialPrincipalResolver {
  async resolve(req: ControlRequest, _command: CommandName, _args: Record<string, unknown>): Promise<EditorialPrincipal> {
    const raw = firstHeader(req.headers[DEV_EDITORIAL_PRINCIPAL_HEADER])?.trim();
    if (!raw) {
      throw new ControlProblem(
        401,
        "editorial-assertion-missing",
        "Editorial assertion missing",
        "Every content write carries an editorial principal (dev-mode stub reads x-webdesk-editorial-principal; " +
          "WSK-40 replaces it with a signed x-webdesk-editorial-assertion).",
      );
    }
    if (!raw.startsWith("{")) {
      if (raw.length > 200) throw malformed("editorial principal subject is too long");
      return { sub: raw, pk: "human", jti: randomUUID() };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw malformed("editorial principal header is not valid JSON");
    }
    const sub = parsed.sub;
    const pk = parsed.pk ?? "human";
    if (typeof sub !== "string" || sub.length === 0 || sub.length > 200) throw malformed("sub must be a non-empty string");
    if (typeof pk !== "string" || !(EDITORIAL_PRINCIPAL_KINDS as string[]).includes(pk)) {
      throw malformed("pk must be human | automation | agent");
    }
    const principal: EditorialPrincipal = { sub, pk: pk as EditorialPrincipal["pk"], jti: randomUUID() };
    for (const k of ["agt", "req", "apr"] as const) {
      const v = parsed[k];
      if (v === undefined) continue;
      if (typeof v !== "string" || v.length === 0 || v.length > 200) throw malformed(`${k} must be a non-empty string`);
      principal[k] = v;
    }
    if ((principal.pk === "agent") !== (principal.agt !== undefined)) {
      throw malformed("agt is present iff pk = agent");
    }
    // WSK-49b: the same optional boolean the signed assertion carries (a non-boolean is refused, never coerced).
    if (parsed.ce !== undefined) {
      if (typeof parsed.ce !== "boolean") throw malformed("ce must be a boolean when present");
      if (parsed.ce) principal.clientEditor = true;
    }
    // M5-W1e: and the optional boolean `xc` (contributor). Present together with `ce` is refused, as the real verifier does.
    if (parsed.xc !== undefined) {
      if (typeof parsed.xc !== "boolean") throw malformed("xc must be a boolean when present");
      if (parsed.ce !== undefined) {
        throw new ControlProblem(401, "editorial-assertion-claims", "Editorial assertion claims invalid", "xc and ce are mutually exclusive: a contributor is never a client editor");
      }
      if (parsed.xc) principal.contributor = true;
    }
    return principal;
  }
}
