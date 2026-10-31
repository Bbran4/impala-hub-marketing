-- Run only in a disposable migrated local database. Everything is rolled back.
-- Compare the legacy per-row policy with the currently installed policy using
-- identical 10,000-row data, indexes, caller and queries.
begin;
create temp table benchmark_policy as
select pg_get_expr(polqual,polrelid) expression from pg_policy
where polrelid='public.sales_desk_rfqs'::regclass and polname='sales desk users read permitted rfqs';
insert into auth.users(id,email,raw_user_meta_data) values
('12399999-0000-0000-0000-000000000001','benchmark-sales@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values('12399999-0000-0000-0000-000000000001','sales');
insert into public.sales_desk_sales_codes(id,code) values
('12399999-0000-0000-0000-000000000002','BENCH-OWN'),('12399999-0000-0000-0000-000000000003','BENCH-OTHER');
update public.profiles set sales_code='BENCH-OWN' where id='12399999-0000-0000-0000-000000000001';
alter table public.sales_desk_rfqs disable trigger user;
insert into public.sales_desk_rfqs(rfq_no,business_date,daily_number,media_platform_id,status_id,customer_name,created_by,updated_by,sales_code_id,received_at)
select 'RLS-BENCH-'||i,'2034-01-01',i,(select id from public.sales_desk_media_platforms limit 1),
 (select id from public.sales_desk_statuses limit 1),'Benchmark customer', '12399999-0000-0000-0000-000000000001','12399999-0000-0000-0000-000000000001',
 case i%3 when 0 then null when 1 then '12399999-0000-0000-0000-000000000002'::uuid else '12399999-0000-0000-0000-000000000003'::uuid end,
 '2020-01-01'::timestamptz+i*interval '1 minute' from generate_series(1,10000)i;
alter table public.sales_desk_rfqs enable trigger user;
analyze public.sales_desk_rfqs;
alter policy "sales desk users read permitted rfqs" on public.sales_desk_rfqs using(public.sales_desk_can_read_rfq(id));
set local role authenticated;
set local request.jwt.claims='{"sub":"12399999-0000-0000-0000-000000000001","role":"authenticated"}';
select 'legacy_count' as benchmark;
explain(analyze,buffers,format json) select count(*) from public.sales_desk_rfqs where deleted_at is null;
select 'legacy_page' as benchmark;
explain(analyze,buffers,format json) select id from public.sales_desk_rfqs where deleted_at is null order by received_at desc,id limit 50;
reset role;
do $$declare expression text;begin
 select b.expression into expression from benchmark_policy b;
 execute 'alter policy "sales desk users read permitted rfqs" on public.sales_desk_rfqs using ('||expression||')';
end$$;
set local role authenticated;
select 'optimized_count' as benchmark;
explain(analyze,buffers,format json) select count(*) from public.sales_desk_rfqs where deleted_at is null;
select 'optimized_page' as benchmark;
explain(analyze,buffers,format json) select id from public.sales_desk_rfqs where deleted_at is null order by received_at desc,id limit 50;
select 'optimized_rpc' as benchmark;
explain(analyze,buffers,format json) select public.sales_desk_rfq_page('{"sort":"received_desc"}');
rollback;
