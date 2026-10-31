begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
('12100000-0000-0000-0000-000000000001','history.metrics@test.invalid','{"display_name":"History Admin"}');
insert into public.profile_roles(profile_id,role_id) values
('12100000-0000-0000-0000-000000000001','administrator') on conflict do nothing;
set local request.jwt.claims='{"sub":"12100000-0000-0000-0000-000000000001","role":"authenticated"}';
insert into public.posts(id,title,caption,channels,created_by) values
('12100000-0000-0000-0000-000000000002','Editorial title','Original caption',array['facebook'],
 '12100000-0000-0000-0000-000000000001');
select is((select count(*) from public.audit_log where entity_type='post' and entity_id='12100000-0000-0000-0000-000000000002' and action='created'),1::bigint,'post creation still produces history');
create temp table audit_baseline as select count(*) n from public.audit_log where entity_type='post' and entity_id='12100000-0000-0000-0000-000000000002';

-- Separate writes ensure no single metric accidentally remains audit-worthy.
do $$declare metric text; begin
  foreach metric in array array['clicks','reach','impressions','views','likes','comments','shares','reactions','engagements','saves'] loop
    execute format('update public.posts set %I=1 where id=%L',metric,'12100000-0000-0000-0000-000000000002');
    execute format('update public.posts set %I=null where id=%L',metric,'12100000-0000-0000-0000-000000000002');
  end loop;
end$$;
update public.posts set metrics_refreshed_at=now(),updated_at=now() where id='12100000-0000-0000-0000-000000000002';
select is((select count(*) from public.audit_log where entity_type='post' and entity_id='12100000-0000-0000-0000-000000000002'),(select n from audit_baseline),'all individual counters, null resets and refresh timestamps are silent');

update public.posts set caption='Edited caption',likes=42,comments=3,views=100,metrics_refreshed_at=now()
where id='12100000-0000-0000-0000-000000000002';
select is((select count(*) from public.audit_log where entity_type='post' and entity_id='12100000-0000-0000-0000-000000000002'),(select n+1 from audit_baseline),'a mixed editorial and metric update creates one history row');
select is((select details->'changed' from public.audit_log where entity_type='post' and entity_id='12100000-0000-0000-0000-000000000002' order by id desc limit 1),'["caption"]'::jsonb,'mixed history lists only editorial fields');
select ok(exists(select 1 from public.audit_log where entity_type='post' and entity_id='12100000-0000-0000-0000-000000000002' and action='updated' and actor_id=auth.uid() and details->>'actor_name'='History Admin'),'actor attribution remains intact');

update public.posts set status='scheduled',publish_at=now()+interval '1 day',shares=12 where id='12100000-0000-0000-0000-000000000002';
select is((select details->'changed' from public.audit_log where entity_type='post' and entity_id='12100000-0000-0000-0000-000000000002' order by id desc limit 1),'["publish_at","status"]'::jsonb,'scheduling remains audited without metric noise');
update public.posts set status='published',published_at=now(),provider_ids='{"facebook":"121_2"}',reach=10,impressions=30
where id='12100000-0000-0000-0000-000000000002';
select is((select details->'changed' from public.audit_log where entity_type='post' and entity_id='12100000-0000-0000-0000-000000000002' order by id desc limit 1),'["provider_ids","published_at","status"]'::jsonb,'publication receipts and lifecycle changes remain audited');

truncate audit_baseline;
insert into audit_baseline select count(*) from public.audit_log where entity_type='post' and entity_id='12100000-0000-0000-0000-000000000002';
select public.sync_facebook_post('{"caption":"Edited caption","media":[],"provider_ids":{"facebook":"121_2"},"likes":50,"comments":4,"shares":20,"views":200,"reach":40,"impressions":80,"clicks":9}',auth.uid());
select is((select count(*) from public.audit_log where entity_type='post' and entity_id='12100000-0000-0000-0000-000000000002'),(select n from audit_baseline),'the real sync RPC creates no metric-only history');
select is((select likes from public.posts where id='12100000-0000-0000-0000-000000000002'),50,'sync still saves current metrics');
select public.sync_facebook_post('{"caption":"Changed on Facebook","media":[],"provider_ids":{"facebook":"121_2"},"likes":51}',auth.uid());
select is((select details->'changed' from public.audit_log where entity_type='post' and entity_id='12100000-0000-0000-0000-000000000002' order by id desc limit 1),'["caption"]'::jsonb,'sync still audits content changed on Facebook');

insert into public.campaigns(id,name) values('12100000-0000-0000-0000-000000000003','History campaign');
set local role authenticated;
select public.save_marketing_post('12100000-0000-0000-0000-000000000002','{"campaign_id":"12100000-0000-0000-0000-000000000003"}');
select is((select details->'changed' from public.audit_log where entity_type='post' and entity_id='12100000-0000-0000-0000-000000000002' order by id desc limit 1),'["campaign_id"]'::jsonb,'browser campaign assignment is still audited');
select throws_ok($$update public.posts set likes=999 where id='12100000-0000-0000-0000-000000000002'$$,'42501',null,'suppressing metric history does not grant browser metric writes');
select ok(not has_function_privilege('authenticated','public.audit_marketing_post()','execute'),'audit trigger remains unavailable as a browser RPC');
reset role;
delete from public.posts where id='12100000-0000-0000-0000-000000000002';
select is((select count(*) from public.audit_log where entity_type='post' and entity_id='12100000-0000-0000-0000-000000000002' and action='deleted'),1::bigint,'deletion history remains available');
select * from finish();
rollback;
