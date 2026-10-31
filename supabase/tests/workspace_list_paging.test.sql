begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
('12300000-0000-0000-0000-000000000001','paging-admin@test.invalid','{}'),
('12300000-0000-0000-0000-000000000002','paging-outsider@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values
('12300000-0000-0000-0000-000000000001','administrator'),('12300000-0000-0000-0000-000000000002','sales') on conflict do nothing;
set local request.jwt.claims='{"sub":"12300000-0000-0000-0000-000000000001","role":"authenticated"}';
insert into public.sales_desk_rfqs(rfq_no,business_date,daily_number,media_platform_id,status_id,customer_name,created_by,updated_by,received_at)
select 'PAGER-'||i,'2033-01-01',i,(select id from public.sales_desk_media_platforms limit 1),
 (select id from public.sales_desk_statuses where not is_closed limit 1),'PagerRfq '||case when i=1005 then '100%_match' else i::text end,
 auth.uid(),auth.uid(),'2021-01-01' from generate_series(1,1005)i;
insert into public.returns_claims(date,company,rfc_book_number,customer,contact_person,contact_number,invoice_number,invoice_date,reason,part_number,description,qty,created_by,updated_by)
select (now() at time zone 'Africa/Johannesburg')::date-8,'Warehouse',i::text,'PagerClaim '||i,'Test','1','I',current_date,'Core','PART','Description',1,auth.uid(),auth.uid()
from generate_series(1,1005)i;
insert into public.stock_import_batches(id,source_type,source_name,imported_by)
values('12300000-0000-0000-0000-000000000003','manual_csv','paging.csv',auth.uid());
select public.append_stock_booking_items('12300000-0000-0000-0000-000000000003',
 (select jsonb_agg(jsonb_build_object('part_number','PAGER-'||lpad(i::text,4,'0'),'qoh_wh',25)) from generate_series(1,1005)i));
select public.append_stock_reordering_items('12300000-0000-0000-0000-000000000003',
 (select jsonb_agg(jsonb_build_object('part_number','PAGER-'||lpad(i::text,4,'0'),'description','PagerStock','supplier_type',case when i%2=0 then 'local' else 'international' end,'avg_sales',1,'global_safety',100,'qoh_wh',25)) from generate_series(1,1005)i));
select public.validate_stock_import('12300000-0000-0000-0000-000000000003');
select public.activate_stock_import('12300000-0000-0000-0000-000000000003');

set local role authenticated;
select is((public.sales_desk_rfq_page('{"search":"PagerRfq"}')->>'total')::integer,1005,'RFQ count spans the full matching set');
select is(jsonb_array_length(public.sales_desk_rfq_page('{"search":"PagerRfq"}')->'items'),50,'RFQs return a single 50-row default page');
select is(jsonb_array_length(public.sales_desk_rfq_page('{"search":"PagerRfq"}',50,1000)->'items'),5,'RFQ final page remains reachable beyond 1000');
select is((public.sales_desk_rfq_page('{"search":"100%_match"}')->>'total')::integer,1,'RFQ search treats wildcards literally');
select ok((public.sales_desk_rfq_page('{"search":"PagerRfq"}',50,0)->'items'->0->>'id') is distinct from
 (public.sales_desk_rfq_page('{"search":"PagerRfq"}',50,50)->'items'->0->>'id'),'tied RFQ dates have stable distinct page boundaries');
select is((public.sales_desk_rfq_page('{"search":"PagerRfq","type":"invoice"}')->>'total')::integer,0,'RFQ filters apply before pagination');
select throws_ok($$select public.sales_desk_rfq_page('{}',201)$$,'22023',null,'RFQ page size is bounded');
select throws_ok($$select public.sales_desk_rfq_page('{"sort":"bad;drop table posts"}')$$,'22023',null,'RFQ sort injection rejected');
select is((public.returns_claim_page('{"search":"PagerClaim"}')->>'total')::integer,1005,'Returns count spans all matching claims');
select is(jsonb_array_length(public.returns_claim_page('{"search":"PagerClaim"}')->'items'),50,'Returns returns only one page');
select is(jsonb_array_length(public.returns_claim_page('{"search":"PagerClaim"}',50,1000)->'items'),5,'Returns final page remains reachable');
select is((public.returns_claim_page('{"search":"PagerClaim"}')->'summary'->>'open')::integer,1005,'Returns summary covers all matches, not only the current page');
select is((public.returns_claim_page('{"search":"PagerClaim","sla":"overdue"}')->>'total')::integer,1005,'SLA filtering uses Johannesburg dates');
select is((public.returns_claim_page('{"search":"PagerClaim","company":"Pretoria"}')->>'total')::integer,0,'company filters affect counts before paging');
select ok(not (public.returns_claim_page('{"search":"PagerClaim"}')->'items'->0 ? 'attachments'),'list pages omit legacy attachment JSON');
select throws_ok($$select public.returns_claim_page('{"from":"2025-02-01","to":"2025-01-01"}')$$,'22023',null,'inverted date filter rejected');
select throws_ok($$select public.returns_claim_page('{}',50,-1)$$,'22023',null,'negative Returns offset rejected');
select is((public.stock_reordering_page('{"search":"PagerStock"}')->>'total')::integer,1005,'Reordering count spans the active snapshot');
select is(jsonb_array_length(public.stock_reordering_page('{"search":"PagerStock"}')->'items'),200,'Reordering returns one bounded page');
select is(jsonb_array_length(public.stock_reordering_page('{"search":"PagerStock"}',200,1000)->'items'),5,'Reordering final page remains reachable');
select is((public.stock_reordering_page('{"search":"PagerStock","supplierType":"local","mover":"slow","supply":25}')->>'total')::integer,502,'supplier, mover and exact supply boundary filter before paging');
select is(public.stock_reordering_page('{}')->'activeSnapshot'->>'source_name','paging.csv','metadata belongs to the same snapshot as the page');
select is((public.stock_reordering_page('{"sort":"part_number","direction":"desc"}')->'items'->0->>'part_number'),'PAGER-1005','server sorting precedes paging');
select throws_ok($$select public.stock_reordering_page('{"sort":"qty_to_order;drop table posts"}')$$,'22023',null,'stock sort injection rejected');
select throws_ok($$select public.stock_reordering_page('{}',201)$$,'22023',null,'stock page size is bounded');
reset role;
update public.sales_desk_rfqs set deleted_at=now() where rfq_no='PAGER-1';
update public.returns_claims set deleted_at=now() where customer='PagerClaim 1';
set local role authenticated;
select is((public.sales_desk_rfq_page('{"search":"PagerRfq"}')->>'total')::integer,1004,'RFQ totals exclude soft-deleted rows');
select is((public.returns_claim_page('{"search":"PagerClaim"}')->>'total')::integer,1004,'Returns totals exclude soft-deleted rows');
set local request.jwt.claims='{"sub":"12300000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((public.returns_claim_page()->>'total')::integer,0,'Returns RPC preserves workspace RLS');
select is((public.stock_reordering_page()->>'total')::integer,0,'stock RPC preserves workspace RLS');
select ok(not has_function_privilege('anon','public.sales_desk_rfq_page(jsonb,integer,integer)','execute'),'anonymous RFQ RPC access denied');
select ok(not has_function_privilege('anon','public.returns_claim_page(jsonb,integer,integer,boolean)','execute'),'anonymous Returns RPC access denied');
select ok(not has_function_privilege('anon','public.stock_reordering_page(jsonb,integer,integer)','execute'),'anonymous stock RPC access denied');
select * from finish();
rollback;
