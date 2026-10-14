// DW-8j (DW-D24, docs/FRONTEND-BFF-CONTRACT.md §48.1) — the SIMULATED mailboxes: one per person, in process memory, nothing else.
//
// WHAT "SIMULATED" MEANS HERE, AND WHY IT IS PROVABLE:
//   * every mailbox is a `GmailFixtureClient` (the MAIL-16D corpus) over a `sent` list this class owns, keyed by the person's user id;
//   * the lists live in one `Map` on an INSTANCE (the service creates one), so they are lost on restart and shared with no other process;
//   * nothing here touches the disk, the database, a socket or the mail module's queue/sender: this file and fixture-client.ts import no
//     network or mail library and never call `fetch` (gmail.simulated-isolation.test.ts scans both for exactly that), so a message "sent"
//     here cannot leave the box. The only way out is the live adapter, which core/gmail selects only when GMAIL_MODE=live.
//
// The map is keyed by the person alone, never by tenant or a client-supplied value: a person has one mailbox, and the service passes the
// authenticated caller's id.
import { SIMULATED_SENT_CAP, createFixtureGmailClient } from "./fixture-client";
import type { GmailClient, GmailMessage } from "./types";

/** How many people's simulated Sent folders one process holds before the least recently used is dropped. A bound, not a feature. */
export const SIMULATED_MAILBOX_CAP = 1000;

export class SimulatedMailboxes {
  private readonly sentByOwner = new Map<string, GmailMessage[]>();

  /** The person's own simulated mailbox as a `GmailClient`. A page size of 20 matches the live list. */
  clientFor(ownerId: string, accountEmail: string, opts: { pageSize?: number; now?: () => Date } = {}): GmailClient {
    return createFixtureGmailClient({ pageSize: opts.pageSize ?? 20, sent: this.sentFor(ownerId), accountEmail, now: opts.now });
  }

  /** How many messages the person's simulated Sent holds (a test and diagnostics read; never message content). */
  sentCount(ownerId: string): number {
    return this.sentByOwner.get(ownerId)?.length ?? 0;
  }

  /** Total people holding a simulated Sent right now. */
  mailboxCount(): number {
    return this.sentByOwner.size;
  }

  /** Forgets one person's simulated Sent (disconnect), or everyone's. */
  clear(ownerId?: string): void {
    if (ownerId === undefined) this.sentByOwner.clear();
    else this.sentByOwner.delete(ownerId);
  }

  private sentFor(ownerId: string): GmailMessage[] {
    let sent = this.sentByOwner.get(ownerId);
    if (sent) {
      // refresh recency: a Map iterates in insertion order, so re-inserting makes this person the newest
      this.sentByOwner.delete(ownerId);
    } else {
      sent = [];
      if (this.sentByOwner.size >= SIMULATED_MAILBOX_CAP) {
        const oldest = this.sentByOwner.keys().next().value;
        if (oldest !== undefined) this.sentByOwner.delete(oldest);
      }
    }
    this.sentByOwner.set(ownerId, sent);
    return sent;
  }
}

export { SIMULATED_SENT_CAP };
