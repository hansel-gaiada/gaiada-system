/**
 * P11 - Jobs / queue. A queued job runs on its own tick, entirely outside
 * any HTTP request - there is no "request" to hang AsyncLocalStorage
 * context off, so whatever tenant a job's work belongs to MUST travel as
 * serialized job.input and be re-threaded by the task handler itself
 * (payload.config.ts's `probeTenantRead` task does exactly this). That is a
 * property of async job queues in general, not a Payload-specific gap: no
 * queue preserves ambient call-stack context across the queue boundary.
 * `probeTenantReadNaive` is the same task minus that one line, run here to
 * show what happens if a handler is written without it - the load-bearing
 * question being whether the omission LEAKS another tenant's rows or just
 * fails closed.
 */
import { ACME, GLOBEX, APP_URI, bootPayload, check, summary } from '../src/lib.mjs';
import { runWithTenant } from '../src/tenant-context.mjs';

const payload = await bootPayload({ databaseUri: APP_URI });

await runWithTenant(ACME, () => payload.create({ collection: 'pages', data: { tenantId: ACME, title: 'ACME jobs page' } }));
await runWithTenant(GLOBEX, () => payload.create({ collection: 'pages', data: { tenantId: GLOBEX, title: 'GLOBEX jobs page' } }));

// well-behaved task: re-threads tenant context itself from job.input
{
  const job = await payload.jobs.queue({ task: 'probeTenantRead', input: { tenantId: ACME } });
  await payload.jobs.runByID({ id: job.id });
  const doc = await payload.findByID({ collection: 'payload-jobs', id: job.id });
  const titles = doc.taskStatus?.probeTenantRead
    ? Object.values(doc.taskStatus.probeTenantRead)[0]?.output?.titles
    : doc.output?.titles;
  check(
    'P11 well-behaved task (explicit re-thread): sees only its own tenant\'s rows',
    Array.isArray(titles) && titles.length > 0 && titles.every((t) => t.startsWith('ACME')),
    `job doc: ${JSON.stringify(doc.taskStatus ?? doc.output)}`,
  );
}

// naive task: same job system, no re-thread - queued and run with NO active
// ALS context at all (this script does not wrap the queue/run calls in
// runWithTenant either, matching "nobody at any layer supplied a tenant").
{
  const job = await payload.jobs.queue({ task: 'probeTenantReadNaive', input: { tenantId: GLOBEX } });
  await payload.jobs.runByID({ id: job.id });
  const doc = await payload.findByID({ collection: 'payload-jobs', id: job.id });
  const titles = doc.taskStatus?.probeTenantReadNaive
    ? Object.values(doc.taskStatus.probeTenantReadNaive)[0]?.output?.titles
    : doc.output?.titles;
  check(
    'P11 naive task (no re-thread) fails CLOSED, not leaked',
    Array.isArray(titles) && titles.length === 0,
    `expected zero rows (fail-closed); job doc: ${JSON.stringify(doc.taskStatus ?? doc.output)}`,
  );
}

const ok = summary('P11 Jobs/queue');
await payload.destroy();
process.exit(ok ? 0 : 1);
