-- Storage enforces these restrictions for every upload, independently of the UI.
-- Updating bucket configuration preserves existing objects and access policies.
update storage.buckets
set file_size_limit=15728640,
    allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif']
where id='marketing-media';

update storage.buckets
set file_size_limit=15728640,
    allowed_mime_types=array['image/jpeg','image/png','image/webp']
where id='profile-avatars';

update storage.buckets
set file_size_limit=15728640,
    allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif',
      'application/pdf','application/msword','application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
where id='sales-desk-attachments';

-- Chat keeps its existing 25 MB per-file limit, with an explicit business-file
-- allowlist rather than unrestricted application/octet-stream or image/*.
update storage.buckets
set file_size_limit=26214400,
    allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif',
      'application/pdf','application/msword','application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain','text/csv']
where id='chat-attachments';
