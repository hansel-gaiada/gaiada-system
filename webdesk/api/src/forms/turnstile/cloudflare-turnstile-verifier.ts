// WSK-10 — the REAL Cloudflare Turnstile verifier. Built but never activated by this ticket:
// `turnstileConfig.mode` defaults to "stub" everywhere (forms.config.ts) and this ticket sets
// TURNSTILE_MODE nowhere — flipping it to "live" needs a real `TURNSTILE_SECRET_KEY`, which is
// explicitly out of scope ("real keys are on the Staging Reopen Register, do NOT activate one").
// Exists so the seam is provably real, not just a stub with nothing to swap to.
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { turnstileConfig } from "../forms.config";
import type { TurnstileVerifier } from "./turnstile-verifier";

type SiteverifyResponse = { success: boolean; ["error-codes"]?: string[] };

@Injectable()
export class CloudflareTurnstileVerifier implements TurnstileVerifier {
  readonly mode = "live" as const;

  async verify(token: string | undefined, remoteIp: string | undefined): Promise<boolean> {
    if (!token) return false;
    if (!turnstileConfig.secretKey) {
      // A "live" mode with no secret configured is a deployment mistake, not "let everything
      // through" — fail closed and loud, same doctrine as clamav/media's unreachable-scanner path.
      throw new ServiceUnavailableException("TURNSTILE_MODE=live but TURNSTILE_SECRET_KEY is unset");
    }

    const body = new URLSearchParams({ secret: turnstileConfig.secretKey, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), turnstileConfig.requestTimeoutMs);
    try {
      const res = await fetch(turnstileConfig.verifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ServiceUnavailableException(`turnstile siteverify returned HTTP ${res.status}`);
      }
      const json = (await res.json()) as SiteverifyResponse;
      return json.success === true;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      throw new ServiceUnavailableException(`turnstile siteverify unreachable: ${String(err)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
