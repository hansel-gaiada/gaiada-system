-- Finance F2-05 — the IAM half of posting rules (2026-08-24).
--
-- DERIVED from the catalog and the generated bundles. 4 grantable permissions on ONE new Cerbos
-- kind, finance_posting_rule, for 202608241027.
--
-- ── AUTHORING A RULE IS AUTHORING ACCOUNTING POLICY ────────────────────────────────────────────
-- A posting rule decides which accounts every future event of its type lands in. Whoever controls
-- that controls where revenue, cost and tax appear in the financial statements — without ever
-- touching a journal. It is a quieter authority than posting and a wider one: a single rule edit
-- re-points an entire event stream.
--
-- So activate is separated from author and held at D4 high assurance. Drafting a mapping for
-- review is ordinary work; making it live is the decision.
--
-- ── process IS THE AGENT AND AUTOMATION PATH, AND IS DELIBERATELY WIDE ─────────────────────────
-- This program-s agentic-native bar requires a capability to work identically under a human, under
-- n8n and under an agent. Processing the queue is that capability: it applies a mapping somebody
-- else authored and approved, and every posting still passes F1-s guards — balance, period,
-- account, chain, idempotency. It cannot invent accounting; it can only apply it.
--
-- That is why module_staff holds it and why an AUTOMATION PRINCIPAL may legitimately be granted
-- it. What such a principal must NEVER hold is author or activate — the difference between
-- executing a policy and writing one.
--
-- ── THE TIERS ──────────────────────────────────────────────────────────────────────────────────
--   finance_staff    read, process — runs the queue, cannot change the mapping.
--   finance_manager  everything, including activate at high assurance.
--   company_admin    read ONLY. An administrative role has no business deciding where revenue
--                    lands, and no business running the accounting queue either.
--
-- ROLE-ARM ONLY, no perm_* mirror. Additive.

INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('finance.posting_rule.read', 'finance', 'posting_rule', 'read',
   'Read posting rules, the finance event inbox and the unprocessed backlog.',
   'finance_posting_rule', 'read', 'grantable', true, true),
  ('finance.posting_rule.process', 'finance', 'posting_rule', 'process',
   'Run a business event through its posting rule, and sweep the pending queue. Applies an approved mapping; cannot invent accounting.',
   'finance_posting_rule', 'process', 'grantable', true, true),
  ('finance.posting_rule.author', 'finance', 'posting_rule', 'author',
   'Create and edit DRAFT posting rules — the mapping from a business event to accounts.',
   'finance_posting_rule', 'author', 'grantable', true, true),
  ('finance.posting_rule.activate', 'finance', 'posting_rule', 'activate',
   'Make a posting rule live, or retire one. A single activation re-points an entire event stream.',
   'finance_posting_rule', 'activate', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

-- Bundles, emitted from role-permission-bundles.json so the two cannot disagree.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',    'finance.posting_rule.read'),

  ('finance_manager',  'finance.posting_rule.activate'),
  ('finance_manager',  'finance.posting_rule.author'),
  ('finance_manager',  'finance.posting_rule.process'),
  ('finance_manager',  'finance.posting_rule.read'),

  ('finance_staff',    'finance.posting_rule.process'),
  ('finance_staff',    'finance.posting_rule.read'),

  ('owner',            'finance.posting_rule.read'),

  ('platform_admin',   'finance.posting_rule.activate'),
  ('platform_admin',   'finance.posting_rule.author'),
  ('platform_admin',   'finance.posting_rule.process'),
  ('platform_admin',   'finance.posting_rule.read')
) AS v(role_name, perm_key)
JOIN roles       r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);
