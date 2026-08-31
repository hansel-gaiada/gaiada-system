// WSK-10 — the dev stub. Accepts EXACTLY ONE token value (`turnstileConfig.stubPassToken`,
// default "stub-pass") and refuses everything else, including undefined/empty — deliberately NOT
// "accept anything" (that would prove nothing about the seam being wired at all: the abuse
// battery's "missing/bad Turnstile 403 (stub mode proves the seam)" case needs a stub that can
// actually FAIL, not one that rubber-stamps every request). Never calls out to the network, never
// reads a real secret — this is the mode every environment runs in until a real Cloudflare
// Turnstile site+secret key pair is issued (Staging Reopen Register; NOT this ticket's job to
// activate).
import { Injectable } from "@nestjs/common";
import { turnstileConfig } from "../forms.config";
import type { TurnstileVerifier } from "./turnstile-verifier";

@Injectable()
export class StubTurnstileVerifier implements TurnstileVerifier {
  readonly mode = "stub" as const;

  async verify(token: string | undefined): Promise<boolean> {
    return typeof token === "string" && token === turnstileConfig.stubPassToken;
  }
}
