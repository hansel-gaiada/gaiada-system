// MAIL-16D — runs the shared, provider-agnostic contract suite (contract.ts) against the
// fixture-backed `GmailClient`. This is the ONLY place fixture-specific fixed points (a known
// thread id, a known message id, ...) are named — they are handed into the harness here and never
// leak into contract.ts itself. At staging, MAIL-16's live adapter gets its OWN file exactly like
// this one — same import of `runGmailClientContractTests`, different harness — and that is what
// "the live adapter must pass MAIL-16D's contract suite unmodified" means in practice: this file
// does not change, a sibling file for the live adapter is added.
import { runGmailClientContractTests } from "./contract";
import {
  FIXTURE_KNOWN_LABEL_NAME,
  FIXTURE_KNOWN_MESSAGE_ID,
  FIXTURE_KNOWN_THREAD_ID,
  FIXTURE_THREAD_COUNT,
  FIXTURE_UNKNOWN_ID,
  createFixtureGmailClient,
  createRateLimitedFixtureGmailClient,
  createRevokedFixtureGmailClient,
  createUnauthorizedFixtureGmailClient,
} from "./fixture-client";

runGmailClientContractTests("GmailFixtureClient", () => ({
  // pageSize 2 against a 5-thread corpus (FIXTURE_THREAD_COUNT) guarantees >1 page, so this
  // implementation genuinely exercises the pagination assertions rather than opting out of them.
  client: createFixtureGmailClient({ pageSize: 2 }),
  knownThreadId: FIXTURE_KNOWN_THREAD_ID,
  knownMessageId: FIXTURE_KNOWN_MESSAGE_ID,
  knownLabelName: FIXTURE_KNOWN_LABEL_NAME,
  unknownId: FIXTURE_UNKNOWN_ID,
  supportsPagination: FIXTURE_THREAD_COUNT > 2,
  createUnauthorizedClient: createUnauthorizedFixtureGmailClient,
  createRevokedClient: createRevokedFixtureGmailClient,
  createRateLimitedClient: createRateLimitedFixtureGmailClient,
}));
