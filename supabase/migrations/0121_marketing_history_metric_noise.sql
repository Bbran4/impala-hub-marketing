-- Post history records editorial and lifecycle changes, not engagement polling.
-- Keep the same trigger, actor attribution, transaction and access restrictions.
create or replace function public.audit_marketing_post()
returns trigger language plpgsql security definer set search_path='' as $$
declare before_row jsonb := case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
  after_row jsonb := case when tg_op='DELETE' then '{}'::jsonb else to_jsonb(new) end;
  changed text[]; actor_name text;
begin
  select array_agg(k order by k) into changed from (
    select jsonb_object_keys(before_row || after_row) k
  ) keys where k not in ('updated_at','metrics_refreshed_at',
    'clicks','reach','impressions','views','likes','comments','shares','reactions','engagements','saves') and before_row->k is distinct from after_row->k;
  if tg_op='UPDATE' and coalesce(cardinality(changed),0)=0 then return new; end if;
  select coalesce(nullif(p.display_name,''),p.email) into actor_name from public.profiles p where p.id=auth.uid();
  insert into public.audit_log(actor_id,action,entity_type,entity_id,details)
  values(auth.uid(),case tg_op when 'INSERT' then 'created' when 'DELETE' then 'deleted' else 'updated' end,
    'post',coalesce(new.id,old.id)::text,jsonb_build_object('changed',changed,'status',coalesce(new.status,old.status),
    'actor_name',coalesce(actor_name,'System'),
    'before',jsonb_build_object('status',before_row->'status','campaign_id',before_row->'campaign_id','publish_at',before_row->'publish_at'),
    'after',jsonb_build_object('status',after_row->'status','campaign_id',after_row->'campaign_id','publish_at',after_row->'publish_at')));
  return coalesce(new,old);
end $$;
revoke all on function public.audit_marketing_post() from public,anon,authenticated;
