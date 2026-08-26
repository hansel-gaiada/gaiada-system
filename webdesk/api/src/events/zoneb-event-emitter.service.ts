// WSK-12 — the Zone B emitter. Design §03 channel 1 + the ticket's own hard rule: "Fail-soft — a
// bridge outage must never break a form submission." Every public method on this class is
// structurally incapable of throwing: the one internal `deliver()` call is wrapped in a
// try/catch that logs and returns, never rethrows, so a caller (WSK-10's FormsService, once
// wired — see this ticket's report for the exact hook line) can call `emitFormReceived(...)`
// as a fire-and-forget without its own try/catch.
//
// ── WHY THIS IS NOT WIRED INTO FormsModule HERE ─────────────────────────────────────────────────
// `forms.service.ts` is not this ticket's owned path (the ticket's hard constraints list
// `webdesk/api/src/events/**` + its own test files only). Same posture WSK-10/11 each already
// took for their own out-of-scope wiring (forms.module.ts's own header: "NOT registered in
// AppModule ... Required change, to be applied by whoever owns that file") — the required one-line
// hook is documented in this ticket's report, not made here.
import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { eventsConfig } from "./events.config";
import { computeSignatureHex, formatSignatureHeader } from "./zoneb-event-signature";
import type { FormReceivedData, ZoneBEventEnvelope, ZoneBEventKind } from "./zoneb-event.types";

@Injectable()
export class ZoneBEventEmitterService {
  private readonly logger = new Logger(ZoneBEventEmitterService.name);

  /** Generic emit — every specific `emitXxx` helper below is a thin, typed wrapper over this.
   *  NEVER throws; every failure path is caught and logged at `warn`, matching the doctrine
   *  `media/clamav.service.ts` and `forms.service.ts`'s own mail dispatch already use elsewhere
   *  in this project for "a downstream outage must not fail the request that triggered it". */
  async emit<TData extends Record<string, unknown>>(
    kind: ZoneBEventKind,
    tenantId: string,
    data: TData,
  ): Promise<void> {
    if (!eventsConfig.enabled) {
      this.logger.debug(`zoneb event ${kind} not emitted — WEBDESK_ZONEB_EVENTS_ENABLED=false`);
      return;
    }
    if (!eventsConfig.bridgeUrl) {
      this.logger.warn(`zoneb event ${kind} not emitted — WEBDESK_ZONEB_BRIDGE_URL is unset`);
      return;
    }
    if (!eventsConfig.secret) {
      // Fail-soft still applies to a missing secret — an unsigned or wrongly-signed delivery is
      // strictly worse than none (the receiver would just refuse it anyway; better to never spend
      // the network call and log loudly that the seam is misconfigured).
      this.logger.warn(`zoneb event ${kind} not emitted — WEBDESK_EVENT_SECRET is unset`);
      return;
    }

    const envelope: ZoneBEventEnvelope<TData> = {
      eventId: randomUUID(),
      kind,
      tenantId,
      originSite: eventsConfig.originSite,
      occurredAt: new Date().toISOString(),
      data,
    };

    try {
      await this.deliver(envelope);
    } catch (err) {
      // The ticket's own words: "a bridge outage must never break a form submission." This is the
      // ONE place that promise is kept — every caller of `emit`/`emitFormReceived` relies on this
      // never rejecting.
      this.logger.warn(`zoneb event ${kind} delivery failed (fail-soft, no retry): ${String(err)}`);
    }
  }

  async emitFormReceived(tenantId: string, data: FormReceivedData): Promise<void> {
    return this.emit("form.received", tenantId, data);
  }

  private async deliver(envelope: ZoneBEventEnvelope): Promise<void> {
    const rawBody = JSON.stringify(envelope);
    const timestampMs = Date.now().toString();
    const signatureHex = computeSignatureHex(eventsConfig.secret, timestampMs, rawBody);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), eventsConfig.requestTimeoutMs);
    try {
      const res = await fetch(eventsConfig.bridgeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webdesk-Timestamp": timestampMs,
          "X-Webdesk-Signature": formatSignatureHeader(signatureHex),
        },
        body: rawBody,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`bridge returned HTTP ${res.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
