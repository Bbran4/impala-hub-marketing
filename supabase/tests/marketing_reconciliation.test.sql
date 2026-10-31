begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
('11500000-0000-0000-0000-000000000001','review-admin@test.invalid','{}'),
('11500000-0000-0000-0000-000000000002','review-normal-admin@test.invalid','{}'),
('11500000-0000-0000-0000-000000000003','review-writer@test.invalid','{}'),
('11500000-0000-0000-0000-000000000004','review-inactive@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values
('11500000-0000-0000-0000-000000000001','administrator'),('11500000-0000-0000-0000-000000000002','administrator'),
('11500000-0000-0000-0000-000000000003','marketing'),('11500000-0000-0000-0000-000000000004','administrator');
update public.profiles set normal_user_view=true where id='11500000-0000-0000-0000-000000000002';
update public.profiles set active=false where id='11500000-0000-0000-0000-000000000004';
insert into public.posts(id,title,status,publish_started_at,created_by) values
('11500000-0000-0000-0001-000000000001','Unknown A','publish_unknown',now()-interval '20 minutes','11500000-0000-0000-0000-000000000001'),
('11500000-0000-0000-0001-000000000002','Unknown B','publish_unknown',now()-interval '21 minutes','11500000-0000-0000-0000-000000000001'),
('11500000-0000-0000-0001-000000000003','Fresh in progress','publishing',now(),'11500000-0000-0000-0000-000000000001'),
('11500000-0000-0000-0001-000000000004','Fresh unknown','publish_unknown',now(),'11500000-0000-0000-0000-000000000001'),
('11500000-0000-0000-0001-000000000005','Stale in progress','publishing',now()-interval '20 minutes','11500000-0000-0000-0000-000000000001');
select is((select count(*) from public.user_notifications where target_record_id='11500000-0000-0000-0001-000000000001'),2::bigint,'unknown outcome notifies each active administrator once');
select is((select count(*) from public.user_notifications where user_id='11500000-0000-0000-0000-000000000003'),0::bigint,'ordinary marketing users receive no administrative alerts');
select is((select count(*) from public.user_notifications where user_id='11500000-0000-0000-0000-000000000004'),0::bigint,'inactive administrators receive no alerts');
update public.posts set status='publish_unknown' where id='11500000-0000-0000-0001-000000000001';
select is((select count(*) from public.user_notifications where target_record_id='11500000-0000-0000-0001-000000000001'),2::bigint,'repeated outcome writes do not duplicate alerts');
select ok(not has_function_privilege('authenticated','public.complete_marketing_reconciliation(uuid,timestamptz,timestamptz,text,text,text,timestamptz,uuid,text,boolean,boolean)','execute'),'browser cannot bypass provider verification through the completion RPC');
select ok(has_function_privilege('service_role','public.complete_marketing_reconciliation(uuid,timestamptz,timestamptz,text,text,text,timestamptz,uuid,text,boolean,boolean)','execute'),'trusted server can complete a verified review');
set local role authenticated;
set local request.jwt.claims='{"sub":"11500000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select count(*) from jsonb_array_elements(public.marketing_reconciliation_queue()->'posts') p where p->>'id' like '11500000-%'),5::bigint,'normal-view administrator sees every unresolved attempt in settings');
select is((select count(*) from public.user_notifications where kind='marketing_publish_unknown'),3::bigint,'normal-view administrator can read system alerts without Marketing app access');
set local request.jwt.claims='{"sub":"11500000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok($sql$select public.marketing_reconciliation_queue()$sql$,'42501',null,'ordinary writer cannot use the administrative queue');
select throws_ok($sql$update public.posts set status='draft' where id='11500000-0000-0000-0001-000000000002'$sql$,'42501',null,'browser cannot reset an uncertain outcome');
reset role;
select throws_ok($sql$delete from public.posts where id='11500000-0000-0000-0001-000000000002'$sql$,'55000',null,'an unresolved attempt cannot be deleted');
create function pg_temp.review115(p_id uuid,p_resolution text,p_note text default 'Checked the connected Facebook Page.',p_absent boolean default true,
  p_actor uuid default '11500000-0000-0000-0000-000000000001') returns jsonb language sql as $$
  select public.complete_marketing_reconciliation(p.id,p.updated_at,p.publish_started_at,p_resolution,
    case when p_resolution='published' then '123_456' else null end,
    case when p_resolution='published' then 'https://www.facebook.com/123_456' else null end,
    case when p_resolution='published' then p.publish_started_at+interval '1 second' else null end,p_actor,p_note,p_absent)
  from public.posts p where p.id=p_id;
$$;
select throws_ok($sql$select pg_temp.review115('11500000-0000-0000-0001-000000000003','published')$sql$,'55000',null,'live publishing cannot be interrupted by review');
select throws_ok($sql$select pg_temp.review115('11500000-0000-0000-0001-000000000004','draft')$sql$,'55000',null,'recent uncertainty cannot be reset before the ten-minute wait');
select throws_ok($sql$select pg_temp.review115('11500000-0000-0000-0001-000000000002','draft','Checked the Page.',false)$sql$,'55000',null,'return to draft needs explicit absence confirmation');
select throws_ok($sql$select pg_temp.review115('11500000-0000-0000-0001-000000000002','draft','short')$sql$,'22023',null,'review notes must explain what was checked');
select throws_ok($sql$select pg_temp.review115('11500000-0000-0000-0001-000000000002','draft','Checked the Page.',true,'11500000-0000-0000-0000-000000000003')$sql$,'42501',null,'server completion validates the administrator actor');
select throws_ok($sql$select public.complete_marketing_reconciliation('11500000-0000-0000-0001-000000000002',now()-interval '1 day',now()-interval '21 minutes','draft',null,null,null,'11500000-0000-0000-0000-000000000001','Checked the Page.',true)$sql$,'40001',null,'stale review cannot overwrite a changed publishing attempt');
select lives_ok($sql$select pg_temp.review115('11500000-0000-0000-0001-000000000001','published')$sql$,'verified post can be marked published');
select is((select provider_ids->>'facebook' from public.posts where id='11500000-0000-0000-0001-000000000001'),'123_456','verified Facebook receipt is stored');
select is((select count(*) from public.audit_log where entity_id='11500000-0000-0000-0001-000000000001' and action='reconciled' and actor_id='11500000-0000-0000-0000-000000000001'),1::bigint,'review writes an attributed audit entry');
select is((select count(*) from public.user_notifications where target_record_id='11500000-0000-0000-0001-000000000001' and read_at is null),0::bigint,'successful review clears related unread alerts');
select throws_ok($sql$select pg_temp.review115('11500000-0000-0000-0001-000000000005','published')$sql$,'23505',null,'a receipt cannot be attached to two local posts');
create function pg_temp.reject_review115() returns trigger language plpgsql as $$begin
  if new.action='reconciled' and new.details->>'note'='Force audit failure' then raise exception 'Audit failed';end if;return new;end$$;
create trigger reject_review115 before insert on public.audit_log for each row execute function pg_temp.reject_review115();
select throws_ok($sql$select pg_temp.review115('11500000-0000-0000-0001-000000000002','draft','Force audit failure')$sql$,'P0001',null,'audit failure rolls back reconciliation');
select is((select status from public.posts where id='11500000-0000-0000-0001-000000000002'),'publish_unknown','failed audit retains the unresolved status');
select lives_ok($sql$select pg_temp.review115('11500000-0000-0000-0001-000000000002','draft')$sql$,'checked absent publication can return to draft');
select ok((select publish_at is null and publish_started_at is null from public.posts where id='11500000-0000-0000-0001-000000000002'),'returning to draft never reschedules or republishes');
-- Sync may have imported the accepted provider post before review. An explicit
-- merge preserves the original editorial record and archives the complete copy.
insert into public.posts(id,title,caption,status,publish_started_at,created_by) values
('11500000-0000-0000-0001-000000000006','Keep original title','Merge content','publish_unknown',now()-interval '20 minutes','11500000-0000-0000-0000-000000000001');
insert into public.posts(id,title,caption,status,provider_ids,created_by,likes) values
('11500000-0000-0000-0001-000000000007','','Merge content','published','{"facebook":"123_789"}','11500000-0000-0000-0000-000000000003',12);
select lives_ok($sql$select public.complete_marketing_reconciliation(p.id,p.updated_at,p.publish_started_at,'published','123_789','https://www.facebook.com/123_789',p.publish_started_at+interval '1 second','11500000-0000-0000-0000-000000000001','Verified matching imported publication.',false,true) from public.posts p where p.id='11500000-0000-0000-0001-000000000006'$sql$,'explicit duplicate merge succeeds atomically');
select is((select title from public.posts where id='11500000-0000-0000-0001-000000000006'),'Keep original title','merge retains the authored title');
select is((select created_by from public.posts where id='11500000-0000-0000-0001-000000000006'),'11500000-0000-0000-0000-000000000001'::uuid,'merge retains the original owner');
select is((select count(*) from public.posts where provider_ids->>'facebook'='123_789'),1::bigint,'only one canonical provider identity remains');
select is((select snapshot->>'caption' from public.marketing_reconciled_imports where imported_post_id='11500000-0000-0000-0001-000000000007'),'Merge content','the full imported record is retained in the archive');
select * from finish();
rollback;
