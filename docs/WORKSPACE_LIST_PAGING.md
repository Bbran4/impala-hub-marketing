# Server-paged workspace lists

Migration 0123_workspace_list_paging.sql adds security-invoker RPCs for RFQs,
Returns claims and Stock Reordering. Every RPC validates the page size and offset,
applies search/filters/sorting before paging, returns a full matching count and
uses the record ID as a final tie breaker. Existing RLS remains authoritative.

- RFQs load 50 rows. Status, sales code, type, literal search and sort run in SQL.
  Oldest-first keeps unclaimed RFQs first; newest-first remains available.
- Returns loads 50 rows. Company, reason, outcome, status, date range, SLA and
  document/customer search run in SQL. Summary and breakdown counts aggregate
  **all matching claims**, not the visible page. SLA uses Johannesburg dates.
- Reordering loads 200 rows. Supplier type, mover thresholds, supply percentage,
  search and sorting run in SQL over the active snapshot. Snapshot metadata and
  settings come back in the same statement as the page.

Search is debounced by 300 ms. Changing filters resets the page; stale requests
cannot overwrite newer results. If deletion makes the current page invalid,
the list reloads the final available page.

Only an explicit Returns export reads all matching rows, in 200-row requests.
List rendering never runs that loop. Exports reject missing pages, duplicate IDs
or changed totals rather than silently returning a partial report. These requests
are not a multi-request database snapshot; retry the export if records change.
The old RFQ load-all helper and Reordering 100,000-row browser loop are removed.

## RFQ policy measurement

The previous SELECT policy called sales_desk_can_read_rfq(id) for every row.
The new policy compares row fields directly and evaluates caller-only permission,
role and sales-code lookups with scalar subqueries. PostgreSQL can evaluate those
as statement-level InitPlans. This follows
[Supabase's RLS performance guidance](https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select).
Attachment authorization still uses the existing parent-record checks.

Local measurement on 2026-10-31: PostgreSQL via PGlite, 10,000 synthetic RFQs,
one active salesperson, one-third own code, one-third unclaimed, one-third another
code. Both policies used identical rows, indexes and queries. There were 6,667
visible RFQs. EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) reported:

| Query | Previous policy | New policy |
| --- | ---: | ---: |
| Count visible RFQs | 3,566.424 ms | 6.887 ms |
| Fetch newest 50 IDs | 25.713 ms | 1.013 ms |
| Complete new page RPC, including count and joined fields | — | 23.005 ms |

The old plan applied the parent lookup to every scanned row. The new plans showed
four InitPlans, each with Actual Loops: 1; both policies returned identical row
counts. The page query used a received-date index.

These single-run local-engine timings are illustrative, not hosted Supabase
latency guarantees or a production load test. Reproduce on a disposable migrated
Supabase database with supabase/benchmarks/rfq_read_policy.sql; it temporarily
swaps policies for comparison and rolls back fixtures and policy changes.

Regression checks cover pages beyond 1,000 rows, stable date ties, literal
wildcards, full-set summaries, soft deletion, invalid sorts/page bounds, roles,
permission overrides, administrator normal view and explicit export completeness.
