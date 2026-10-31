begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
('11700000-0000-0000-0000-000000000001','marketing.photos@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values
('11700000-0000-0000-0000-000000000001','administrator') on conflict do nothing;

-- Old/imported publications can contain provider formats outside new-upload limits.
insert into public.posts(id,title,status,media,created_by) values
('11700000-0000-0000-0000-000000000002','Historical import','published',
 (select jsonb_agg(jsonb_build_object('url','https://storage.example/'||n||'.jpg')) from generate_series(1,11)n),
 '11700000-0000-0000-0000-000000000001');
-- Reproduce a legacy invalid draft without changing production validation rules.
alter table public.posts disable trigger check_marketing_outbound_media;
insert into public.posts(id,title,status,media,created_by) values
('11700000-0000-0000-0000-000000000003','Legacy invalid','draft','[{"url":"http://old.example/photo"}]',
 '11700000-0000-0000-0000-000000000001');
alter table public.posts enable trigger check_marketing_outbound_media;

set local role authenticated;
set local request.jwt.claims='{"sub":"11700000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($$select public.save_marketing_post(null,'{"title":"Text only","media":[],"status":"draft"}')$$,'text-only posts still save');
select lives_ok($$select public.save_marketing_post(null,'{"title":"Photos","media":[{"url":"https://storage.example/a.jpg","content_type":"image/jpeg","size":100},{"url":"https://storage.example/b.png","content_type":"image/png","size":15728640}],"status":"draft"}')$$,'multiple images save atomically');
select lives_ok($$select public.save_marketing_post((select id from public.posts where title='Photos'),jsonb_build_object('status','scheduled','publish_at',now()+interval '1 day'))$$,'multi-photo drafts can be scheduled');
select is((select jsonb_array_length(media) from public.posts where title='Photos'),2,'scheduling preserves image order and count');
select lives_ok($$select public.save_marketing_post(null,jsonb_build_object('title','Ten photos','media',(select jsonb_agg(jsonb_build_object('url','https://storage.example/'||n||'.jpg')) from generate_series(1,10)n)))$$,'ten-image application limit is accepted');
select throws_ok($$select public.save_marketing_post(null,jsonb_build_object('media',(select jsonb_agg(jsonb_build_object('url','https://storage.example/'||n||'.jpg')) from generate_series(1,11)n)))$$,'22023',null,'oversized batch rejected during draft save');
select throws_ok($$select public.save_marketing_post(null,'{"media":{}}')$$,'22023',null,'malformed media list rejected');
select throws_ok($$select public.save_marketing_post(null,'{"media":[{}]}')$$,'22023',null,'missing image URL rejected');
select throws_ok($$select public.save_marketing_post(null,'{"media":[{"url":"http://storage.example/a.jpg"}]}')$$,'22023',null,'insecure image URL rejected');
select throws_ok($$select public.save_marketing_post(null,'{"media":[{"url":"https://token:secret@storage.example/a.jpg"}]}')$$,'22023',null,'credential-bearing image URL rejected');
select throws_ok($$select public.save_marketing_post(null,'{"media":[{"url":"https://storage.example/a.mp4","content_type":"video/mp4"}]}')$$,'22023',null,'non-image attachment rejected');
select throws_ok($$select public.save_marketing_post(null,'{"media":[{"url":"https://storage.example/a.jpg","size":15728641}]}')$$,'22023',null,'oversized image rejected');
select throws_ok($$select public.save_marketing_post(null,'{"media":[{"url":"https://storage.example/a.jpg","size":"secret"}]}')$$,'22023',null,'non-numeric size rejected safely');
select throws_ok($$insert into public.posts(created_by,media) values(auth.uid(),'[{"url":"javascript:bad"}]')$$,'22023',null,'direct browser insert cannot bypass media validation');
select throws_ok($$update public.posts set media='[{"url":"http://bad"}]' where title='Text only'$$,'22023',null,'direct browser edit cannot bypass media validation');
select throws_ok($$select public.save_marketing_post('11700000-0000-0000-0000-000000000003',jsonb_build_object('status','scheduled','publish_at',now()+interval '1 day'))$$,'22023',null,'legacy invalid media is checked before scheduling');
select is((select status from public.posts where title='Legacy invalid'),'draft','rejected schedule leaves draft intact');
select lives_ok($$select public.save_marketing_post('11700000-0000-0000-0000-000000000003','{"media":[{"url":"https://storage.example/fixed.jpg"}]}')$$,'legacy draft can be repaired');
select lives_ok($$select public.save_marketing_post('11700000-0000-0000-0000-000000000002','{"campaign_id":null}')$$,'historical publication remains editable for campaign assignment');
select ok(not has_function_privilege('anon','public.validate_marketing_post_media(jsonb)','execute'),'anonymous callers cannot invoke media validator');
select * from finish();
rollback;
