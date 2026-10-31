# Marketing publishing integrity rollout

Post history excludes metric-only updates, including clicks, reach, impressions,
views, likes, comments, shares, reactions, engagements, saves and refresh timestamps
(migration `0121_marketing_history_metric_noise.sql`). Mixed edits produce one
event listing only editorial/lifecycle fields. Creation, deletion, campaign changes
and publishing receipts remain audited; existing history is retained.

The Supabase GitHub integration applies database migrations for the connected branch; confirm its migration run succeeded alongside the Vercel deployment. Migration `0093_marketing_publish_integrity.sql` established the lifecycle protections below.

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

## Multi-photo publishing

Migration `0117_marketing_multi_photo.sql` validates new or changed outbound attachments and rechecks existing media before scheduling. The editor and publisher share the same application limit: ten HTTPS images, JPG/PNG/WEBP/GIF, up to 15 MB each. Invalid batches are rejected before storage uploads or scheduling; historical imports retain their original media.

For two to ten images, the publisher uploads each photo with `published: false` and `temporary: true`, in editor order, then creates exactly one Page feed post with `attached_media`. A staging failure is safely marked failed because no public story was requested. A timeout, malformed result or failed receipt after the final call remains an unknown outcome requiring administrator review. No automatic final retry or deletion of potentially attached photos occurs. Unconfirmed staging assets can remain unpublished on Facebook.

Every Facebook request remains bounded to 20 seconds. Both manual and scheduled publishing have 300-second Vercel limits; the scheduler reserves the complete photo-upload and receipt budget before claiming another post, leaving excess work for the next two-minute run.

Tests cover multi-image ordering, one final story, staging failures, ambiguous final outcomes, receipt failures, early validation, SQL schedule rejection and batch time budgets. No live Facebook posts are created by these tests. See Meta [Page Photos](https://developers.facebook.com/docs/graph-api/reference/page/photos/) for the unpublished-photo and attached-media flow.
