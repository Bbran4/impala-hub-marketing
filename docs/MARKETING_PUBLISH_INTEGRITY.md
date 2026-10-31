# Marketing publishing integrity rollout

Apply migration `0093_marketing_publish_integrity.sql` before serving the updated Marketing handlers. GitHub/Vercel deployment does not apply Supabase migrations automatically. No new environment variables are needed.

If migration 0093 reports duplicate Facebook identities, reconcile those records first. It intentionally preserves all rows rather than guessing which title, campaign assignment or owner should survive. Find conflicts with:

```sql
select provider_ids->>'facebook' as facebook_id, array_agg(id) as post_ids
from public.posts
where nullif(provider_ids->>'facebook','') is not null
group by provider_ids->>'facebook' having count(*) > 1;
```

Both publishers atomically claim the current row before contacting Facebook. Requests have a 20-second timeout. A definitive provider rejection may become `failed`; timeouts, uncertain responses and failed receipt saves become `publish_unknown`. Neither manual publishing nor cron retries unknown outcomes. The cron quarantines `publishing` attempts older than ten minutes, including unfinished attempts from the previous deployment. Run the authenticated scheduler after rollout to recover those attempts promptly.

There is no distributed transaction between Facebook and Supabase. Migration `0115_marketing_publish_reconciliation.sql` adds an administrator review queue in App Settings, System alerts for unknown outcomes, a provider-verified reconciliation API, and an audited server-only completion transaction. The Board and detail views show Publishing and Needs review explicitly.

Use the review UI rather than manual SQL: verify an existing Facebook publication, optionally merge its matching imported local copy, or return a confirmed absent attempt to draft after ten minutes. Queue reads and reconciliation are reserved for active administrator accounts. Normal view retains access through App Settings. Browser clients cannot call the completion RPC or write lifecycle fields directly. A stale attempt/version, a live publishing run, an unverified provider identity, or conflicting campaign assignments aborts the transaction. Imported snapshots are retained in `marketing_reconciled_imports`; a failed audit write rolls back the entire resolution. See `FACEBOOK_SETUP.md` for the review workflow.

Browser writes cannot change lifecycle, provider IDs, metrics, owner or existing identity fields. Content edits are restricted to draft/awaiting-approval/failed posts without a Facebook receipt; locked posts retain permission-checked campaign reassignment. The frontend uses `save_marketing_post` to validate and save content/scheduling atomically. Only service-role calls can invoke `sync_facebook_post`; it serializes each provider identity and preserves local title, campaign, owner and other provider IDs.

Verification: run frontend tests, the frontend production build, and `supabase test db` against a migrated local stack. Database regression tests cover identity uniqueness, sync preservation, protected fields and scheduling. Publisher tests cover competing claims, canonical photo IDs, timeouts, provider rejection, failed receipt persistence and stable media identity.
