-- Widen `webdev_sites.origin` to accept 'probe'.
--
-- My own gap, found the moment real data met the constraint: the registry's `origin` CHECK allows
-- ('nexus-import','provisioned','manual') while `search_properties.topology_source` — added in the
-- same afternoon, for the same purpose — allows ('nexus-import','probe','manual'). Two provenance
-- vocabularies for one concept, disagreeing on the value that matters most.
--
-- 'probe' is the honest label for the estate survey and for everything MON-01 will produce: facts
-- observed from outside, never read off a server. The alternative was to seed 30 real rows as
-- 'manual', which would have recorded a human assertion where there was a measurement — precisely
-- the distinction the provenance column exists to preserve.
--
-- Widen-only and idempotent: drop the constraint if present, re-add including the new value. No
-- existing row can violate it, because the new set is a superset of the old.

ALTER TABLE webdev_sites DROP CONSTRAINT IF EXISTS webdev_sites_origin_check;
ALTER TABLE webdev_sites ADD CONSTRAINT webdev_sites_origin_check
  CHECK (origin IN ('nexus-import', 'provisioned', 'manual', 'probe'));

COMMENT ON COLUMN webdev_sites.origin IS
  'How this row came to exist. probe = observed from outside (DNS/HTTP/TLS), never read off a '
  'server - the estate survey and MON-01 both produce these. nexus-import = a lead to verify, not '
  'a measurement. manual = a human asserted it. provisioned = we created the site.';
