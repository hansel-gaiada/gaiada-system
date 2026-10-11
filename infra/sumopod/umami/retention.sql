-- WSK-D67 / visitor addendum section 5: Umami has no retention control, so this is it.
-- Deletes everything older than the cutoff, in FK-safe order. Table + column names verified against
-- Umami v3.4.0 prisma/schema.prisma (@@map / @map): every table below has created_at timestamptz.
-- Run:  psql -v ON_ERROR_STOP=1 -v months=14 -f retention.sql    (retention.sh does this)
BEGIN;
SELECT (now() - make_interval(months => :months)) AS cutoff \gset

DELETE FROM event_data          WHERE created_at < :'cutoff';
DELETE FROM session_data        WHERE created_at < :'cutoff';
DELETE FROM heatmap_event       WHERE created_at < :'cutoff';
DELETE FROM session_replay      WHERE created_at < :'cutoff';
DELETE FROM revenue             WHERE created_at < :'cutoff';
DELETE FROM website_event       WHERE created_at < :'cutoff';
DELETE FROM session_link        WHERE created_at < :'cutoff';
-- A session row can outlive its first event; only drop sessions that are old AND have no remaining events.
DELETE FROM session s
 WHERE s.created_at < :'cutoff'
   AND NOT EXISTS (SELECT 1 FROM website_event e WHERE e.session_id = s.session_id);
COMMIT;

SELECT 'retention ok events=' || (SELECT count(*) FROM website_event)
    || ' sessions=' || (SELECT count(*) FROM session)
    || ' oldest_event=' || coalesce((SELECT min(created_at)::date::text FROM website_event), 'none');
