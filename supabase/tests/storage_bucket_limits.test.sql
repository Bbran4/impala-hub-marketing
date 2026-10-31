begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

select is((select count(*) from storage.buckets where id in
 ('marketing-media','profile-avatars','sales-desk-attachments','chat-attachments')),4::bigint,'all four upload buckets exist');
select is((select file_size_limit from storage.buckets where id='marketing-media'),15728640::bigint,'marketing has a 15 MB server limit');
select is((select file_size_limit from storage.buckets where id='profile-avatars'),15728640::bigint,'avatars have a 15 MB server limit');
select is((select file_size_limit from storage.buckets where id='sales-desk-attachments'),15728640::bigint,'Sales Desk has a 15 MB server limit');
select is((select file_size_limit from storage.buckets where id='chat-attachments'),26214400::bigint,'chat retains its 25 MB server limit');
select is((select allowed_mime_types from storage.buckets where id='marketing-media'),
 array['image/jpeg','image/png','image/webp','image/gif'],'marketing only allows the supported raster images');
select is((select allowed_mime_types from storage.buckets where id='profile-avatars'),
 array['image/jpeg','image/png','image/webp'],'avatars only allow the supported raster images');
select is((select allowed_mime_types from storage.buckets where id='sales-desk-attachments'),
 array['image/jpeg','image/png','image/webp','image/gif','application/pdf','application/msword','application/vnd.ms-excel',
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
 'Sales Desk allows its supported images and business documents');
select is((select allowed_mime_types from storage.buckets where id='chat-attachments'),
 array['image/jpeg','image/png','image/webp','image/gif','application/pdf','application/msword','application/vnd.ms-excel',
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','text/plain','text/csv'],
 'chat has an explicit business-file allowlist');
select ok(not exists(select 1 from storage.buckets where file_size_limit is null or file_size_limit<=0
 or coalesce(cardinality(allowed_mime_types),0)=0),'all application buckets have finite size and type limits, including Returns');
select is((select public from storage.buckets where id='marketing-media'),true,'marketing public previews remain available');
select is((select public from storage.buckets where id='profile-avatars'),true,'avatar public URLs remain available');
select ok(not exists(select 1 from storage.buckets where id in ('sales-desk-attachments','chat-attachments','returns-claim-attachments') and public),'business attachments remain private');
select is((select file_size_limit from storage.buckets where id='returns-claim-attachments'),15728640::bigint,'Returns keeps its existing size limit');
set local role authenticated;
do $$begin
  update storage.buckets set file_size_limit=null,allowed_mime_types=null where id='marketing-media';
exception when insufficient_privilege then null;
end$$;
reset role;
select is((select file_size_limit from storage.buckets where id='marketing-media'),15728640::bigint,'browser users cannot remove bucket limits');
set local role anon;
do $$begin
  update storage.buckets set file_size_limit=null,allowed_mime_types=null where id='marketing-media';
exception when insufficient_privilege then null;
end$$;
reset role;
select is((select file_size_limit from storage.buckets where id='marketing-media'),15728640::bigint,'anonymous users cannot remove bucket limits');
select * from finish();
rollback;
