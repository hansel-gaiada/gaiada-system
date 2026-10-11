# erp-edge dynamic routes

One file per ERP name; the file provider watches this directory (read-only mount), so a change needs no restart.

* `erp-insights.yml` - Umami collector (this ticket, WSK-D66).
* `erp-status.yml` - the WebDesk public status page (WSK-D64). Authored by the session that owns that page;
  it lands in this same directory unchanged. Do not edit it here.

File-provider router/middleware/service names are global across the directory: prefix new ones with the file's name.
