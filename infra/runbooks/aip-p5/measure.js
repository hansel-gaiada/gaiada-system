// AIP Phase 5 evidence (AIP-20, AIP-21, AIP-23): a read-only measurement of AI use on the live ERP.
// See docs/plans/2026-10-27-ai-plan.md §6.4 for what it decided on 2026-10-31 and the gates to re-check.
// It prints counts, labels and org node ids only: no names, no text. One read-only transaction, rolled back.
// It reads every company (all ids in the tenant GUC), so it runs inside the platform container with its DATABASE_URL:
//
//   scp infra/runbooks/aip-p5/measure.js gda-aicenter:/tmp/aip-p5-measure.js
//   ssh gda-aicenter 'docker cp /tmp/aip-p5-measure.js gaiada-platform-1:/tmp/m.js &&
//     docker exec -e NODE_PATH=/app/node_modules gaiada-platform-1 node /tmp/m.js;
//     docker exec gaiada-platform-1 rm -f /tmp/m.js; rm -f /tmp/aip-p5-measure.js'
const { Pool } = require("pg");
const p = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const c = await p.connect();
  try {
    await c.query("begin read only");
    const ids = (await c.query("select string_agg(id::text, ',') s from companies")).rows[0].s || "";
    await c.query("select set_config($1,$2,true)", ["app.current_tenant_ids", ids]);
    const q = async (label, sql) => {
      try { const r = await c.query(sql); console.log(label, JSON.stringify(r.rows)); }
      catch (e) { console.log(label, "ERROR", e.message); await c.query("rollback"); await c.query("begin read only"); await c.query("select set_config($1,$2,true)", ["app.current_tenant_ids", ids]); }
    };
    // Span of the data, and how much of it can name a department at all (unit_node_id exists since 469, 2026-10-30).
    await q("span:", "select min(occurred_at) first, max(occurred_at) last, count(*)::int n, count(user_id)::int person_rows, count(distinct user_id)::int people, count(distinct tenant_id)::int companies, count(unit_node_id)::int with_node, min(occurred_at) filter (where unit_node_id is not null) first_node from ai_usage_events");
    // AIP-20: what each task class costs, and on which tier (person rows only; embeds have no person).
    await q("person rows by surface/task/tier:", "select surface, task, tier, count(*)::int n, sum(coalesce(prompt_tokens,0)+coalesce(completion_tokens,0))::int tokens, sum(cost_usd) usd from ai_usage_events where user_id is not null group by 1,2,3 order by n desc limit 30");
    await q("all rows by surface/tier:", "select surface, tier, count(*)::int n, sum(cost_usd) usd from ai_usage_events group by 1,2 order by n desc limit 20");
    // AIP-20: does any department use the assistant differently? Department x surface x task, people per department.
    await q("by department (home) x surface x task:", "select unit_node_id, surface, task, count(*)::int n, count(distinct user_id)::int people, sum(cost_usd) usd from ai_usage_events where user_id is not null group by 1,2,3 order by 1 nulls first, n desc limit 40");
    await q("assistant replies per person-day by department:", "select unit_node_id, count(*)::int person_days, round(avg(n),1) avg_day, max(n)::int max_day from (select unit_node_id, user_id, (occurred_at at time zone 'UTC')::date d, count(*) n from ai_usage_events where surface='assistant' and user_id is not null group by 1,2,3) x group by 1 order by 2 desc");
    await q("tiers chosen on threads:", "select coalesce(brain_tier,'(auto)') tier, (brain_provider is not null) named_provider, count(*)::int threads from assistant_threads group by 1,2 order by 3 desc");
    // AIP-21: where people chat FROM (the turn's department, AIP-10), and what they hand to agents.
    await q("turns by context department:", "select coalesce(pt->'department'->>'nodeId','(none)') dept, count(*)::int turns, count(distinct t.owner_user_id)::int people from assistant_messages m join assistant_threads t on t.id=m.thread_id and t.tenant_id=m.tenant_id, jsonb_array_elements(m.parts) pt where pt->>'type'='turn_context' group by 1 order by 2 desc");
    await q("turns by context page (top 15):", "select coalesce(pt->>'page','(none)') page, count(*)::int turns from assistant_messages m, jsonb_array_elements(m.parts) pt where pt->>'type'='turn_context' group by 1 order by 2 desc limit 15");
    await q("hand-offs by agent x status:", "select agent, status, count(*)::int n, count(distinct owner_user_id)::int people from assistant_handoffs group by 1,2 order by 3 desc");
    await q("hand-offs by the person's home department:", "select m.unit_node_id, h.agent, count(*)::int n from assistant_handoffs h left join org_unit_memberships m on m.tenant_id=h.tenant_id and m.user_id=h.owner_user_id and m.is_primary and m.valid_from<=current_date and (m.valid_to is null or m.valid_to>=current_date) group by 1,2 order by 3 desc limit 20");
    await q("agent rows by task x department:", "select task, unit_node_id, count(*)::int n, sum(cost_usd) usd from ai_usage_events where surface='agent' group by 1,2 order by 3 desc limit 20");
    await q("search/knowledge person rows by department:", "select surface, unit_node_id, count(*)::int n from ai_usage_events where surface in ('search','knowledge') and user_id is not null group by 1,2 order by 3 desc limit 20");
    // Reach: how many people could use it, how many did.
    await q("staff with a primary placement today:", "select count(distinct user_id)::int placed from org_unit_memberships where is_primary and valid_from<=current_date and (valid_to is null or valid_to>=current_date)");
    await q("people who ever used the assistant:", "select count(distinct owner_user_id)::int people, count(*)::int threads from assistant_threads");
    // AIP-23 baseline: is the per-person memory used at all, and how?
    await q("assistant_memory by scope/trust/provenance:", "select scope, trust, provenance, pinned, count(*)::int n, count(distinct owner_user_id)::int owners from assistant_memory group by 1,2,3,4 order by 5 desc");
    await q("threads with a compaction summary:", "select count(*) filter (where compaction_summary is not null)::int compacted, count(*)::int threads from assistant_threads");
    await q("department preambles set:", "select count(*)::int n from assistant_dept_preambles");
    await q("budgets and allowances set:", "select (select count(*)::int from ai_budgets) budgets, (select count(*)::int from ai_person_allowances) allowances");
    await c.query("rollback");
  } catch (e) { console.log("db error:", e.message); } finally { c.release(); p.end(); }
})();
