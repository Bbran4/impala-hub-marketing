# Facebook connection on Supabase and Vercel

Facebook connects through Meta OAuth using the Vercel functions in `frontend/api/marketing/facebook/`. Page access tokens are encrypted and stored in Supabase; they are not configured as browser variables or manually pasted into the application.

## Vercel project settings

Configure these server variables for the deployment environment:

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `META_APP_ID`, `META_APP_SECRET`
- `META_TOKEN_ENCRYPTION_KEY`: a private base64-encoded 32-byte encryption key; keep it stable while encrypted connections exist.
- `FACEBOOK_OAUTH_REDIRECT_URI`: the exact deployed `/api/marketing/facebook/callback` URL registered in Meta.
- `FRONTEND_URL`: the application URL to return to after authorization.
- `CRON_SECRET`: authorizes the scheduled publishing handler.
- Optional `FACEBOOK_API_VERSION`: one Graph version override shared by every Marketing handler. Its default is pinned in `frontend/api/_lib/facebook.ts`.

The UI also needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Private credentials must never use the `VITE_` prefix. Redeploy after changing deployment configuration.

## Connect and verify

1. Give the employee the Marketing account-management permission.
2. Open App Settings â†’ Marketing, or Marketing Accounts when permitted.
3. Select Connect Facebook, complete Meta authorization and choose the Page.
4. Check the connection and refresh posts. Confirm the Page identity, post previews, metrics availability and last successful update time.
5. Publish a controlled test post only when authorized. Verify the confirmed result and provider link before relying on scheduling.

## Scheduled publishing

Migration `0113_marketing_publish_scheduler.sql` installs the Supabase `marketing-publish-due` job every two minutes using `pg_cron` and `pg_net`. The daily Vercel cron entry is removed. `frontend/vercel.json` gives `publish`, `publish-due` and `sync` 300 seconds; the scheduler reserves enough time for each complete post within a four-minute work window. Atomic per-post claims make overlapping runs safe.

The job reads `marketing_publish_cron_secret` from Supabase Vault, falling back to the existing Reporting secret `report_emails_cron_secret`. It must match Vercel's `CRON_SECRET`. If Reporting scheduling already configured that secret, no duplicate credential is needed. Otherwise, set it once in the Supabase SQL editor (never commit the value):

```sql
select vault.create_secret('<the CRON_SECRET from Vercel>', 'marketing_publish_cron_secret');
```

The default origin is `https://impala-hub-marketing.vercel.app`. If the production domain changes, store the new HTTPS origin in Vault as `marketing_publish_base_url`. A browser cannot read the cron token or call the private dispatcher.

Verify the timer from an authenticated administrator session with `supabase.rpc('marketing_publish_scheduler_status')`, or inspect `cron.job` in the SQL editor for the `marketing-publish-due` job. `configured` and `active` must both be true. The migration cannot invent a Vercel secret: a missing Vault token leaves the job unconfigured instead of sending unauthenticated requests. Check Supabase Cron run history and `net._http_response` for failures; HTTP request IDs are returned by the dispatcher.

## Refresh performance

Facebook refresh checks the most recent 100 Page posts with three post workers.
The workers run independently, while attachment and insight requests inside each
worker remain sequential, limiting concurrent Facebook/CDN requests to three per
refresh. Existing local posts are fetched in one batch. Complete attachment data
from the Page response is reused, avoiding an extra lookup for ordinary image or
text posts. Optional insight fallbacks remain supported.

Sync has a four-minute work budget inside its existing five-minute Vercel limit.
Graph and Supabase requests have 20-second bounds; CDN requests retain their
15-second limit and share the run cancellation signal. Workers stop accepting new
posts on failure, cancellation or provider throttling, and all active workers are
drained before the response is returned.

A time-limited or throttled run reports how many posts were checked and does not
advance the last-successful-update time. Refresh again to continue; throttling asks
you to wait first. Unattempted and older posts are prioritized on the next refresh
to avoid rechecking already-completed posts first. Missing optional
insights retain previously saved counters rather than resetting them to null.
Provider error text and tokens are not included in the returned metric diagnostics.
Database identity locking and preservation of local titles/campaigns are unchanged.

This change needs the Vercel deployment only; it adds no migration or secret.

## Multiple images

Attach up to ten images to a post (JPG, PNG, WEBP or GIF, up to 15 MB each). The editor checks the whole selection before uploading and reports errors inside the dialog. Save, Publish now and Schedule support multiple images.

Images are prepared as unpublished Facebook photos and attached to one feed post in the same order as the editor. A failed image preparation creates no public post; an uncertain final publication goes to Publishing review. Instagram publishing remains deferred.

## Review an uncertain publication

The Board includes **Publishing** and **Needs review** columns, and the list can filter either state. Active administrator accounts receive a System notification when publication becomes uncertain. The notification opens **App Settings â†’ Marketing â†’ Publishing review**, including for administrators in normal user view.

The review queue includes every unresolved attempt, regardless of the current post page or month. Use **Find matching Facebook posts**, inspect the candidate on the connected Page, and select **Verify and mark published**. The server checks Page ownership, caption and attempt time before saving the canonical receipt.

If sync imported the same publication separately, explicitly enable the merge option. Only a matching, untitled imported copy can be merged; the original title and owner remain, metrics are retained, and the full imported snapshot is archived. Conflicting campaign assignments must be aligned in Posts before merging.

If the post is absent, wait at least ten minutes, check the Page, tick the absence confirmation and record a review note before **Return to draft after review**. This action never republishes or reschedules anything. Recent in-flight attempts cannot be interrupted, and unresolved records cannot be deleted. All resolutions are audited and checked against the exact publishing attempt to prevent stale reviews overwriting a later run.

Disconnecting removes the saved connection through the app. Revoke access in Facebook Business Integrations separately when required. Instagram and WhatsApp connectivity remain deferred.

## Troubleshooting

- Missing server configuration: check the Vercel environment settings for the deployed environment and redeploy.
- No Pages returned: confirm Page access, authorization choices and the Meta app's permissions.
- Redirect mismatch: the configured callback URL must exactly match Meta's registration.
- Permission or token errors: reconnect through Meta and confirm the required Page permissions were granted.
- Missing database functions or columns: inspect the Supabase GitHub integration and migration results; do not assume a Vercel deployment applies database changes.

For local server-function testing, use the linked Vercel project with `vercel dev`; plain Vite does not execute the server functions. See [Vercel's local development guide](https://vercel.com/docs/cli/dev).
