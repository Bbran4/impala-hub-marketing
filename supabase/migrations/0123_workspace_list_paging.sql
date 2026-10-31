-- Resolve caller-only authorization once per statement, not once per RFQ.
create function public.sales_desk_read_code_ids()
returns uuid[] language sql stable security definer set search_path='' as $$
  select coalesce(array_agg(c.id),'{}'::uuid[]) from public.profiles p
  join public.sales_desk_sales_codes c on upper(btrim(p.sales_code))=upper(c.code)
  where p.id=auth.uid();
$$;
revoke all on function public.sales_desk_read_code_ids() from public,anon;
grant execute on function public.sales_desk_read_code_ids() to authenticated;
drop policy "sales desk users read permitted rfqs" on public.sales_desk_rfqs;
create policy "sales desk users read permitted rfqs" on public.sales_desk_rfqs for select to authenticated
using ((select public.has_application_permission('sales_desk','sales_desk.view')) and (
  (select public.has_role('administrator') or public.has_role('sales_manager') or public.has_role('management')) or
  ((select public.has_role('sales')) and (sales_code_id is null or sales_code_id=any((select public.sales_desk_read_code_ids())::uuid[])))
));

create index sales_desk_rfqs_active_received_page_idx on public.sales_desk_rfqs(received_at desc,id) where deleted_at is null;
create index sales_desk_rfqs_active_queue_page_idx on public.sales_desk_rfqs((sales_code_id is not null),received_at,id) where deleted_at is null;
create index sales_desk_rfqs_active_code_page_idx on public.sales_desk_rfqs(sales_code_id,received_at desc,id) where deleted_at is null;
create index returns_claims_active_page_idx on public.returns_claims(date desc,created_at desc,id) where deleted_at is null;

-- Literal contains search: user-entered %, _ and backslashes are not operators.
create function public.list_search_pattern(p_text text)
returns text language sql immutable set search_path='' as $$
  select '%'||replace(replace(replace(btrim(coalesce(p_text,'')),E'\\',E'\\\\'),'%','\%'),'_','\_')||'%';
$$;
revoke all on function public.list_search_pattern(text) from public,anon;
grant execute on function public.list_search_pattern(text) to authenticated;

create function public.sales_desk_rfq_page(p_filters jsonb default '{}',p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb; ordering text; needle text:=public.list_search_pattern(p_filters->>'search');
begin
  if p_limit is null or p_limit<1 or p_limit>200 or p_offset is null or p_offset<0 or jsonb_typeof(p_filters) is distinct from 'object' then
    raise exception 'Invalid page request' using errcode='22023'; end if;
  ordering:=case coalesce(p_filters->>'sort','received_asc')
    when 'received_asc' then '(r.sales_code_id is not null),r.received_at,r.id'
    when 'received_desc' then 'r.received_at desc,r.id'
    when 'customer' then 'r.customer_name,r.id'
    when 'rfq_no' then 'r.rfq_no desc,r.id' end;
  if ordering is null then raise exception 'Invalid RFQ sort' using errcode='22023'; end if;
  execute format($query$
    with filtered as not materialized (
      select r.* from public.sales_desk_rfqs r where r.deleted_at is null
      and (nullif($1->>'status','') is null or r.status_id=($1->>'status')::uuid)
      and (nullif($1->>'code','') is null or r.sales_code_id=($1->>'code')::uuid)
      and (nullif($1->>'type','') is null or r.rfq_type=$1->>'type')
      and (coalesce(r.rfq_no,'')||' '||coalesce(r.original_rfq_no,'')||' '||r.customer_name||' '||r.document_number) ilike $2
    ), page as (select r.* from filtered r order by %s limit $3 offset $4)
    select jsonb_build_object('total',(select count(*) from filtered),'limit',$3,'offset',$4,'items',
      coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object(
        'media_platform',jsonb_build_object('name',m.name),'status',jsonb_build_object('name',s.name,'is_closed',s.is_closed),
        'sales_code',jsonb_build_object('code',c.code),
        'attachment_count',(select count(*) from public.sales_desk_rfq_attachments a where a.rfq_id=r.id)) order by %s)
        from page r left join public.sales_desk_media_platforms m on m.id=r.media_platform_id
        left join public.sales_desk_statuses s on s.id=r.status_id left join public.sales_desk_sales_codes c on c.id=r.sales_code_id),'[]'::jsonb))
  $query$,ordering,ordering) into result using p_filters,needle,p_limit,p_offset;
  return result;
end $$;

create function public.returns_claim_page(p_filters jsonb default '{}',p_limit integer default 50,p_offset integer default 0,p_summary boolean default true)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb; today date:=(now() at time zone 'Africa/Johannesburg')::date;
begin
  if p_limit is null or p_limit<1 or p_limit>200 or p_offset is null or p_offset<0 or jsonb_typeof(p_filters) is distinct from 'object' then
    raise exception 'Invalid page request' using errcode='22023'; end if;
  if nullif(p_filters->>'from','')::date > nullif(p_filters->>'to','')::date then
    raise exception 'Start date must be before end date' using errcode='22023'; end if;
  if coalesce(p_filters->>'sla','') not in ('','open','overdue','due-soon') then raise exception 'Invalid SLA filter' using errcode='22023'; end if;
  with filtered as materialized (
    select c.*, c.status in ('Completed','Rejected') as closed,
      c.date+c.sla_days as due_on,
      greatest(0,(case when c.status in ('Completed','Rejected') then
        coalesce(c.closed_at,c.updated_at) at time zone 'Africa/Johannesburg' else today::timestamp end)::date-c.date) as age
    from public.returns_claims c where c.deleted_at is null
    and (nullif(p_filters->>'status','') is null or c.status=p_filters->>'status')
    and (nullif(p_filters->>'company','') is null or c.company=p_filters->>'company')
    and (nullif(p_filters->>'reason','') is null or c.reason=p_filters->>'reason')
    and (nullif(p_filters->>'outcome','') is null or case when p_filters->>'outcome'='__unknown' then nullif(c.outcome_request,'') is null else c.outcome_request=p_filters->>'outcome' end)
    and (nullif(p_filters->>'from','') is null or c.date >= (p_filters->>'from')::date)
    and (nullif(p_filters->>'to','') is null or c.date <= (p_filters->>'to')::date)
    and (coalesce(p_filters->>'sla','')='' or (c.status not in ('Completed','Rejected') and (
      p_filters->>'sla'='open' or (p_filters->>'sla'='overdue' and c.date+c.sla_days<today) or
      (p_filters->>'sla'='due-soon' and c.date+c.sla_days between today and today+2))))
    and (coalesce(c.claim_no,'')||' '||c.rfc_book_number||' '||c.customer||' '||c.invoice_number||' '||c.part_number||' '||c.description||' '||coalesce(c.supplier_name,'')) ilike public.list_search_pattern(p_filters->>'search')
  ), page as (select * from filtered order by date desc,created_at desc,id limit p_limit offset p_offset)
  select jsonb_build_object('total',(select count(*) from filtered),'limit',p_limit,'offset',p_offset,
    'items',coalesce((select jsonb_agg(to_jsonb(p)-array['attachments','closed','due_on','age'] order by date desc,created_at desc,id) from page p),'[]'::jsonb),
    'summary',case when p_summary then (select jsonb_build_object(
      'total',count(*),'open',count(*) filter(where not closed),'overdue',count(*) filter(where not closed and due_on<today),
      'dueSoon',count(*) filter(where not closed and due_on between today and today+2),
      'completed',count(*) filter(where status='Completed'),'rejected',count(*) filter(where status='Rejected'),
      'averageAge',coalesce(round(avg(age),1),0),'creditReceived',coalesce(sum(credit_amount) filter(where credit_received_on is not null),0),
      'byStatus',(select coalesce(jsonb_object_agg(status,n),'{}'::jsonb) from(select status,count(*) n from filtered group by status)s),
      'byCompany',(select coalesce(jsonb_object_agg(company,n),'{}'::jsonb) from(select company,count(*) n from filtered group by company)s)) from filtered) else null end)
  into result;
  return result;
end $$;

create function public.stock_reordering_page(p_filters jsonb default '{}',p_limit integer default 200,p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb; sort_key text:=coalesce(p_filters->>'sort','part_number'); direction text:=coalesce(p_filters->>'direction','asc');
begin
  if p_limit is null or p_limit<1 or p_limit>200 or p_offset is null or p_offset<0 or jsonb_typeof(p_filters) is distinct from 'object' then
    raise exception 'Invalid page request' using errcode='22023'; end if;
  if sort_key not in ('franchise','part_number','description','qoh_er','safety_er','qoh_pta','safety_pta','qoh_wh','safety_wh','global_safety','supply_percentage','qty_on_order','qty_to_order','lead_time','avg_sales','sales_this_month','gauge','supplier','last_cost') or direction not in ('asc','desc') then
    raise exception 'Invalid stock sort' using errcode='22023'; end if;
  if coalesce(p_filters->>'mover','all') not in ('all','slow','ab') or coalesce(p_filters->>'supply','') not in ('','25','50') then
    raise exception 'Invalid stock filter' using errcode='22023'; end if;
  execute format($query$
    with filtered as materialized (
      select s.* from public.stock_reordering_workspace s
      where (nullif($1->>'supplierType','') is null or lower(s.supplier_type)=lower($1->>'supplierType'))
      and (coalesce($1->>'mover','all')='all' or ($1->>'mover'='slow' and s.is_slow_mover) or ($1->>'mover'='ab' and s.is_ab_mover))
      and (nullif($1->>'supply','') is null or s.supply_percentage<=($1->>'supply')::numeric)
      and (coalesce(s.part_number,'')||' '||coalesce(s.description,'')||' '||coalesce(s.supplier,'')||' '||coalesce(s.alt_1,'')||' '||coalesce(s.alt_2,'')||' '||coalesce(s.alt_3,'')||' '||coalesce(s.alt_4,'')) ilike $2
    ), page as (select * from filtered order by %I %s nulls last,part_number,id limit $3 offset $4)
    select jsonb_build_object('total',(select count(*) from filtered),'limit',$3,'offset',$4,
      'items',coalesce((select jsonb_agg(to_jsonb(p) order by %I %s nulls last,part_number,id) from page p),'[]'::jsonb),
      'settings',(select to_jsonb(s) from public.stock_settings s where singleton),
      'activeSnapshot',(select jsonb_build_object('id',id,'source_name',source_name,'activated_at',activated_at) from public.stock_import_batches where status='active'))
  $query$,sort_key,direction,sort_key,direction) into result using p_filters,public.list_search_pattern(p_filters->>'search'),p_limit,p_offset;
  return result;
end $$;
revoke all on function public.sales_desk_rfq_page(jsonb,integer,integer),public.returns_claim_page(jsonb,integer,integer,boolean),public.stock_reordering_page(jsonb,integer,integer) from public,anon;
grant execute on function public.sales_desk_rfq_page(jsonb,integer,integer),public.returns_claim_page(jsonb,integer,integer,boolean),public.stock_reordering_page(jsonb,integer,integer) to authenticated;
