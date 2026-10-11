# Zone B contract fixtures

Pure JSON data shared by two test suites that must never import each other.

- `form-received.envelope.json` is the exact wire shape of a WebDesk `form.received` Zone B
  event. `tenantId` stands for a `tenants.company_ref` (the Zone A `companies.id`).
- `form-received.internal-tenant-id.json` is a different uuid standing for WebDesk's internal
  `tenants.id`, used by the ERP test to build the refused case.

Bound by:
- WebDesk: `webdesk/api/test/zoneb-form-received-contract.spec.ts` drives a real submission,
  captures the POSTed bytes, and requires the same key sets and per-key types as this fixture.
- ERP: `platform-nest/src/modules/webdev/zoneb-form-received-contract.test.ts` feeds the fixture
  to `validateZoneBEvent`.

Re-record: if the WebDesk spec fails on a key change, update the envelope (keep values synthetic,
uuids for ids), then confirm the ERP test still passes; change the validator if it does not.
Never add imports across the packages.
