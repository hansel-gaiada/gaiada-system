// Search-Marketing (SEO) department seed — one full client engagement with audits, keywords, KPIs, and briefs.
// Showcases the console with real data: property, engagement with tool_scope, keyword clusters with intent,
// audit findings across severities and statuses, KPI targets, and content briefs. Idempotent: re-running
// enriches an existing DB without duplicating. Direct DB inserts (no running server).
//
// Run: DATABASE_URL=... tsx src/seed/search.ts   (NOBYPASSRLS app role in real envs)
import { newId, withGlobal, withTenants, closePool } from "../db";
import { config } from "../config";
import { migrate } from "../db/migrate";

const site = () => config.originSite;

async function count(tenantId: string, table: string, extra = ""): Promise<number> {
  // `{ modules: ["search"] }` is REQUIRED, not optional: 0034 writes every search_* tenant_isolation
  // policy as `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search')`, so without
  // the module scope in the transaction the rows are invisible on read and rejected on write
  // ("new row violates row-level security policy"). Every withTenants call in this file needs it.
  const { rows } = await withTenants([tenantId], (c) => c.query<{ n: string }>(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1 ${extra}`, [tenantId]), { modules: ["search"] });
  return Number(rows[0].n);
}

export async function seedSearch(): Promise<void> {
  // Get the seeded agency tenant (created by seed:agency). If it doesn't exist, we cannot seed search.
  const agencyTenant = await withGlobal((c) => c.query<{ id: string }>(
    `SELECT id FROM companies WHERE name=$1 AND type='agency' AND deleted_at IS NULL LIMIT 1`,
    ["Gaia Digital Agency"]
  ));
  if (!agencyTenant.rows[0]) {
    console.log("Agency tenant not found. Run seed:agency first.");
    return;
  }
  const tenantId = agencyTenant.rows[0].id;

  // Skip if already seeded (check for an engagement named "Bali Beach SEO")
  const existing = await withTenants([tenantId], (c) => c.query<{ id: string }>(
    `SELECT id FROM search_engagements WHERE tenant_id=$1 AND name=$2 AND deleted_at IS NULL LIMIT 1`,
    [tenantId, "Bali Beach SEO"]
  ), { modules: ["search"] });
  if (existing.rows[0]) {
    console.log(`Search engagement already seeded in tenant ${tenantId}`);
    return;
  }

  // Get the first client (Bali Beach Resort, created by seed:agency)
  const clientRes = await withTenants([tenantId], (c) => c.query<{ id: string }>(
    `SELECT id FROM clients WHERE tenant_id=$1 AND name=$2 AND deleted_at IS NULL LIMIT 1`,
    [tenantId, "Bali Beach Resort"]
  ));
  if (!clientRes.rows[0]) {
    console.log("Client not found. Run seed:agency first.");
    return;
  }
  const clientId = clientRes.rows[0].id;

  // Create property for balibeach.test
  const propertyId = newId();
  const engagementId = newId();
  const clusterId1 = newId();
  const clusterId2 = newId();
  const auditId = newId();
  const setId1 = newId();
  const setId2 = newId();

  await withTenants([tenantId], async (c) => {
    // 1. Insert search_property (verified, active)
    await c.query(
      `INSERT INTO search_properties (id,tenant_id,client_id,domain,site_url,verified_at,status,origin_site)
       VALUES ($1,$2,$3,$4,$5,now(),'active',$6)
       ON CONFLICT (tenant_id, client_id, domain) DO NOTHING`,
      [propertyId, tenantId, clientId, "balibeach.test", "https://www.balibeach.test", site()]
    );

    // 2. Insert search_engagement with tool_scope (several tools enabled, one deliberately disabled)
    const toolScope = {
      rank: { enabled: true, cadence: "weekly", maxKeywords: 500 },
      volume: { enabled: true, cadence: "monthly", maxQueries: 100 },
      backlinks: { enabled: true, cadence: "monthly", maxPages: 1000 },
      ai_visibility: { enabled: false, cadence: null, maxQueries: null }, // Deliberately disabled
      serp: { enabled: true, cadence: "weekly", maxQueries: 50 },
      competitors: { enabled: true, cadence: "monthly", maxPages: 50 },
    };
    await c.query(
      `INSERT INTO search_engagements (id,tenant_id,client_id,property_id,name,status,tool_scope,provider_budget_usd,origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [engagementId, tenantId, clientId, propertyId, "Bali Beach SEO", "active", JSON.stringify(toolScope), 50.00, site()]
    );

    // 3. Insert search_kpi_targets (a couple of targets)
    await c.query(
      `INSERT INTO search_kpi_targets (id,tenant_id,engagement_id,metric_key,baseline_value,target_value,due_period,direction,origin_site)
       VALUES ($1,$2,$3,'organic_sessions',2400,3600,'2026-Q3','up',$4),
              ($5,$2,$3,'top10_keywords',12,25,'2026-Q3','up',$4)
       ON CONFLICT DO NOTHING`,
      [newId(), tenantId, engagementId, site(), newId()]
    );

    // 4. Insert two keyword sets
    await c.query(
      `INSERT INTO search_keyword_sets (id,tenant_id,engagement_id,name,source,origin_site)
       VALUES ($1,$2,$3,'Core Research','client',$4),
              ($5,$2,$3,'Competitor Analysis','research',$4)
       ON CONFLICT DO NOTHING`,
      [setId1, tenantId, engagementId, site(), setId2]
    );

    // 5. Insert ~25 keywords spread across both sets with cluster_id, cluster_label, intent, volume, cpc
    // First set: Core Research keywords (cluster 1)
    const coreKeywords = [
      ["bali beach resort", "en-US", "navigational", clusterId1, "Beach Hospitality", 2800, 18.50],
      ["luxury resort bali", "en-US", "commercial", clusterId1, "Beach Hospitality", 1200, 22.00],
      ["bali hotel oceanfront", "en-US", "informational", clusterId1, "Beach Hospitality", 890, 15.75],
      ["best resort sanur", "en-US", "transactional", clusterId2, "Location Search", 450, 12.30],
      ["bali accommodation near beach", "en-US", "informational", clusterId1, "Beach Hospitality", 340, 10.50],
      ["5 star hotel bali", "en-US", "commercial", clusterId1, "Beach Hospitality", 980, 24.00],
      ["beachfront villa bali", "en-US", "commercial", clusterId2, "Location Search", 620, 18.75],
      ["bali resort booking", "en-US", "transactional", clusterId1, "Beach Hospitality", 1100, 20.25],
      ["bali beach wedding venue", "en-US", "commercial", clusterId2, "Location Search", 380, 16.00],
      ["all inclusive bali resort", "en-US", "transactional", clusterId1, "Beach Hospitality", 640, 19.50],
      ["bali spa resort", "en-US", "informational", clusterId1, "Beach Hospitality", 720, 14.00],
      ["family resort bali", "en-US", "informational", clusterId1, "Beach Hospitality", 520, 11.25],
      ["bali resort pool", "en-US", "informational", clusterId1, "Beach Hospitality", 410, 9.80],
    ];
    // SM-46c (design addendum §A4.7 enumeration, §A9.4): these volume/difficulty/cpc values are
    // vendor-plausible seed data (§A2 default vendor), so every row stamps its provenance rather
    // than leaving metrics_provider/metrics_simulated at their empty/false schema defaults, which
    // would misrepresent seeded demo data as genuinely real per-keyword metrics.
    for (const [kw, locale, intent, cid, label, volume, cpc] of coreKeywords) {
      await c.query(
        `INSERT INTO search_keywords (id,tenant_id,set_id,keyword,locale,intent,cluster_id,cluster_label,volume,difficulty,cpc_usd,origin_site,metrics_provider,metrics_simulated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,45.5,$10,$11,'semrush',true)
         ON CONFLICT (tenant_id, set_id, keyword, locale) DO NOTHING`,
        [newId(), tenantId, setId1, kw, locale, intent, cid, label, volume, cpc, site()]
      );
    }

    // Second set: Competitor Analysis keywords
    const competitorKeywords = [
      ["intercontinental bali", "en-US", "navigational", clusterId2, "Competitor Brand", 1890, 21.00],
      ["marriott bali resort", "en-US", "navigational", clusterId2, "Competitor Brand", 1450, 23.50],
      ["hyatt bali regency", "en-US", "navigational", clusterId2, "Competitor Brand", 980, 20.00],
      ["mandarin oriental bali", "en-US", "commercial", clusterId2, "Competitor Brand", 750, 25.00],
      ["four seasons bali", "en-US", "navigational", clusterId2, "Competitor Brand", 1200, 22.75],
      ["bali beach resorts comparison", "en-US", "informational", clusterId2, "Location Search", 340, 12.50],
      ["luxury resorts in bali", "en-US", "commercial", clusterId2, "Competitor Brand", 890, 19.25],
      ["best value resort bali", "en-US", "commercial", clusterId2, "Location Search", 560, 13.75],
      ["bali resort reviews", "en-US", "informational", clusterId2, "Location Search", 1100, 11.00],
      ["bali resort deals", "en-US", "transactional", clusterId2, "Location Search", 720, 15.50],
      ["book bali resort online", "en-US", "transactional", clusterId2, "Location Search", 480, 14.00],
      ["bali resort all inclusive price", "en-US", "transactional", clusterId2, "Location Search", 310, 16.75],
    ];
    for (const [kw, locale, intent, cid, label, volume, cpc] of competitorKeywords) {
      await c.query(
        `INSERT INTO search_keywords (id,tenant_id,set_id,keyword,locale,intent,cluster_id,cluster_label,volume,difficulty,cpc_usd,origin_site,metrics_provider,metrics_simulated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,52.3,$10,$11,'semrush',true)
         ON CONFLICT (tenant_id, set_id, keyword, locale) DO NOTHING`,
        [newId(), tenantId, setId2, kw, locale, intent, cid, label, volume, cpc, site()]
      );
    }

    // 6. The findings, declared BEFORE the audit row so the audit's severity summary can be
    //    DERIVED from them rather than hand-written. A hand-written breakdown drifted from the
    //    actual rows on the first draft of this seed (it claimed 29 findings while inserting 11),
    //    which would have made the console's audit header disagree with its own findings table —
    //    the "confident wrong answer" failure mode this module keeps producing (tracker §4i).
    const findingConfigs = [
      // Critical
      ["missing_sitemap", "critical", "Technical", "XML sitemap not accessible", 1, ["https://www.balibeach.test/"], "open"],
      // High
      ["robots_blocked", "high", "Crawlability", "robots.txt blocking important pages", 4, ["https://www.balibeach.test/rooms", "https://www.balibeach.test/amenities"], "open"],
      ["duplicate_meta", "high", "On-Page", "Duplicate meta descriptions detected", 7, ["https://www.balibeach.test/page1", "https://www.balibeach.test/page2"], "fixed"],
      ["slow_page_load", "high", "Performance", "Page load time exceeds 3 seconds", 12, ["https://www.balibeach.test/gallery"], "open"],
      // Medium
      ["missing_alt_text", "medium", "On-Page", "Images missing alt text", 23, ["https://www.balibeach.test/rooms/deluxe"], "open"],
      ["weak_internal_links", "medium", "Linking", "Some pages lack internal linking", 5, [], "fixed"],
      ["missing_og_tags", "medium", "Technical", "Open Graph tags missing from key pages", 8, ["https://www.balibeach.test/"], "open"],
      ["unoptimized_images", "medium", "Performance", "Images not optimized for web", 15, ["https://www.balibeach.test/gallery"], "open"],
      // Low
      ["canonical_tag_issues", "low", "Technical", "Canonical tag configuration could be improved", 3, ["https://www.balibeach.test/page1"], "open"],
      ["breadcrumb_missing", "low", "On-Page", "Breadcrumb markup not implemented", 6, ["https://www.balibeach.test/rooms"], "ignored"],
      // Info
      ["no_json_ld", "info", "Markup", "JSON-LD structured data not found", 0, [], "open"],
    ];

    // 7. Insert the audit row, its severity summary computed from the findings above.
    const severityCounts = findingConfigs.reduce<Record<string, number>>((acc, f) => {
      const sev = String(f[1]);
      acc[sev] = (acc[sev] ?? 0) + 1;
      return acc;
    }, {});
    await c.query(
      `INSERT INTO search_audits (id,tenant_id,property_id,kind,source,status,score,summary,report_hash,origin_site)
       VALUES ($1,$2,$3,'technical','crawler','completed',82,$4,'audit_20260729_hash1',$5)
       ON CONFLICT (tenant_id, property_id, kind, report_hash) DO NOTHING`,
      [auditId, tenantId, propertyId, JSON.stringify({
        ...severityCounts,
        total: findingConfigs.length,
      }), site()]
    );

    // 8. Insert audit findings across all severity levels and mix of statuses
    for (const [code, severity, category, message, urlCount, sampleUrls, status] of findingConfigs) {
      await c.query(
        `INSERT INTO search_audit_findings (id,tenant_id,audit_id,code,severity,category,message,url_count,sample_urls,status,origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING`,
        [newId(), tenantId, auditId, code, severity, category, message, urlCount, JSON.stringify(sampleUrls), status, site()]
      );
    }

    // 9. Insert one content brief
    await c.query(
      `INSERT INTO search_content_briefs (id,tenant_id,property_id,topic,status,outline,body,grounding,origin_site)
       VALUES ($1,$2,$3,'Bali Beach Resort: Luxury Getaway Destination','draft',$4,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [newId(), tenantId, propertyId,
        JSON.stringify(["Executive Summary", "Market Position", "Value Propositions", "Target Audience", "Differentiators", "Call-to-Action"]),
        `Bali Beach Resort stands as a premier oceanfront destination offering unparalleled luxury and service in Bali. This guide positions the resort as the ideal choice for discerning travelers seeking authentic Balinese hospitality combined with world-class amenities.

Core Message: Experience Bali's most exclusive beachfront sanctuary, where traditional Balinese culture meets contemporary luxury.

Key Benefits:
- Direct oceanfront access with private beach club
- Award-winning spa and wellness center
- Five-star dining across three world-class restaurants
- Family-friendly activities and personalized concierge service
- Proximity to major attractions (Ubud, Seminyak) within 30 minutes

Target Keywords: luxury resort Bali, oceanfront hotel, beachfront accommodation, all-inclusive Bali`,
        JSON.stringify({
          auditId: auditId,
          findingCount: 11,
          keywordCount: 25,
          knowledgeHits: [
            { sourceRef: "Brand Guidelines Doc", score: 0.92 },
            { sourceRef: "Competitor Analysis", score: 0.78 },
          ],
        }),
        site()]
    );
  }, { modules: ["search"] });

  console.log(`✓ seeded search engagement in tenant ${tenantId}`);
  console.log(`  property: balibeach.test`);
  console.log(`  engagement: Bali Beach SEO (active)`);
  console.log(`  keywords: 25 across 2 clusters`);
  console.log(`  audit: technical crawler with 11 findings (critical/high/medium/low/info mix)`);
  console.log(`  kpi_targets: 2`);
  console.log(`  content_brief: 1`);
}

if (require.main === module) {
  (async () => {
    await migrate();
    await seedSearch();
    await closePool();
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
