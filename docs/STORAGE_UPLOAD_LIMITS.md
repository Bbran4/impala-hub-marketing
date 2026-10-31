# Storage upload limits

Migration `0119_storage_bucket_upload_limits.sql` sets Supabase Storage bucket
configuration so file size and MIME restrictions apply to API uploads and
overwrites, independently of browser validation.

| Bucket | Maximum per file | Allowed formats |
| --- | --- | --- |
| `marketing-media` | 15 MB | JPG, PNG, WEBP, GIF |
| `profile-avatars` | 15 MB | JPG, PNG, WEBP |
| `sales-desk-attachments` | 15 MB | JPG, PNG, WEBP, GIF, PDF, Word DOC/DOCX, Excel XLS/XLSX |
| `chat-attachments` | 25 MB | Sales Desk formats plus PowerPoint PPT/PPTX, TXT, CSV |
| `returns-claim-attachments` | 15 MB (existing) | JPG, PNG, WEBP, GIF, PDF, Word DOC/DOCX, Excel XLS/XLSX |

MB here means 1,048,576 bytes. Wildcard image types, SVG, HTML, executables and
generic `application/octet-stream` are not allowed. The global Supabase Storage
limit must also allow the configured sizes; a lower global limit takes precedence.
Bucket MIME filtering checks the upload's content type; it is not a malware scanner
or a guarantee about the bytes inside a file.

Existing files are retained. This migration does not make private attachments
public or change public image URLs. It does not retroactively scan or remove
existing uploads. The connected Supabase GitHub integration applies the migration;
check its run result alongside the Vercel deployment.

`storage_bucket_limits.test.sql` verifies the migrated configuration and browser
roles cannot remove limits. `scripts/test_storage_upload_limits.py` runs against
the disposable Supabase CI stack and tests the real Storage HTTP API: exact size
boundaries succeed, oversized and unsupported uploads/overwrites fail, and test
objects are removed afterward. The HTTP test deliberately bypasses RLS with the
local service credential to isolate bucket-limit enforcement. It refuses hosted
URLs and does not run outside GitHub Actions.
