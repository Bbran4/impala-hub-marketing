-- Publishing uncertainty must be visible, recipient-notified and resolved
-- through a checked server transaction, never arbitrary browser lifecycle edits.
create function public.marketing_reconciliation_queue()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.can_manage_app_settings() then raise exception 'Administrator settings access required' using errcode='42501'; end if;
  return jsonb_build_object('posts',coalesce((select jsonb_agg(to_jsonb(p) order by
      case p.status when 'publish_unknown' then 0 else 1 end,p.publish_started_at nulls first,p.id)
    from public.posts p where p.status in('publishing','publish_unknown')),'[]'::jsonb),
    'page_id',(select c.page_id from public.provider_connections c where c.provider='facebook' and c.is_workspace_connection));
end;
$$;
revoke all on function public.marketing_reconciliation_queue() from public,anon;
grant execute on function public.marketing_reconciliation_queue() to authenticated;

create function public.notify_marketing_publish_unknown()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status<>'publish_unknown' or (tg_op='UPDATE' and old.status='publish_unknown') then return new; end if;
  insert into public.user_notifications(user_id,channel,kind,title,description,target_page,target_record_id,metadata,dedupe_key)
  select p.id,'system','marketing_publish_unknown','Facebook publication needs review',
    'Facebook may have accepted a post. Review its publishing outcome in Marketing App Settings before retrying.',
    'Admin Settings',new.id,jsonb_build_object('settings_app','marketing','post_id',new.id,'publish_started_at',new.publish_started_at),
    'marketing-publish-unknown:'||new.id||':'||coalesce(new.publish_started_at,new.created_at)::text||':'||p.id
  from public.profiles p join public.profile_roles r on r.profile_id=p.id and r.role_id='administrator'
  where p.active on conflict(dedupe_key) do nothing;
  return new;
end;
$$;
revoke all on function public.notify_marketing_publish_unknown() from public,anon,authenticated;
create trigger posts_notify_publish_unknown after insert or update of status on public.posts
for each row execute function public.notify_marketing_publish_unknown();
-- Backfill existing unresolved attempts with the same idempotent keys.
insert into public.user_notifications(user_id,channel,kind,title,description,target_page,target_record_id,metadata,dedupe_key)
select p.id,'system','marketing_publish_unknown','Facebook publication needs review',
  'Facebook may have accepted a post. Review its publishing outcome in Marketing App Settings before retrying.',
  'Admin Settings',post.id,jsonb_build_object('settings_app','marketing','post_id',post.id,'publish_started_at',post.publish_started_at),
  'marketing-publish-unknown:'||post.id||':'||coalesce(post.publish_started_at,post.created_at)::text||':'||p.id
from public.posts post cross join public.profiles p join public.profile_roles r on r.profile_id=p.id and r.role_id='administrator'
where post.status='publish_unknown' and p.active on conflict(dedupe_key) do nothing;

-- Retain the complete imported snapshot when an explicitly confirmed duplicate
-- is folded into the original authored post.
create table public.marketing_reconciled_imports (
  imported_post_id uuid primary key,kept_post_id uuid not null,actor_user_id uuid not null,
  snapshot jsonb not null,created_at timestamptz not null default now()
);
alter table public.marketing_reconciled_imports enable row level security;
revoke all on public.marketing_reconciled_imports from public,anon,authenticated;
grant select on public.marketing_reconciled_imports to authenticated;
create policy "administrators read reconciled imports" on public.marketing_reconciled_imports for select to authenticated using(public.can_manage_app_settings());

create function public.complete_marketing_reconciliation(p_post_id uuid,p_expected_updated_at timestamptz,
  p_expected_started_at timestamptz,p_resolution text,p_facebook_id text,p_permalink text,p_published_at timestamptz,
  p_actor uuid,p_note text,p_confirmed_absent boolean default false,p_merge_imported boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous public.posts; result public.posts; imported public.posts; age_start timestamptz;
begin
  if not exists(select 1 from public.profiles p join public.profile_roles r on r.profile_id=p.id
    where p.id=p_actor and p.active and r.role_id='administrator') then
    raise exception 'Active administrator required' using errcode='42501'; end if;
  select * into previous from public.posts where id=p_post_id for update;
  if not found then raise exception 'Post not found' using errcode='P0002'; end if;
  if previous.status not in('publishing','publish_unknown') or p_expected_updated_at is null
    or previous.updated_at is distinct from p_expected_updated_at or previous.publish_started_at is distinct from p_expected_started_at then
    raise exception 'This publishing attempt changed. Reload before reconciling.' using errcode='40001'; end if;
  age_start:=coalesce(previous.publish_started_at,previous.updated_at,previous.created_at);
  if previous.status='publishing' and age_start>now()-interval '10 minutes' then
    raise exception 'Publication is still in progress. Wait before reconciling.' using errcode='55000'; end if;
  if length(btrim(coalesce(p_note,'')))<10 or length(p_note)>1000 then raise exception 'Add a review note between 10 and 1000 characters' using errcode='22023'; end if;
  if p_resolution='published' then
    if p_facebook_id is null or p_facebook_id !~ '^[0-9]+_[0-9]+$' or p_published_at is null or p_permalink is null
      or p_permalink !~ '^https://(www\.)?facebook\.com/' then raise exception 'A verified Facebook Page post is required' using errcode='22023'; end if;
    select * into imported from public.posts where id<>p_post_id and provider_ids->>'facebook'=p_facebook_id for update;
    if found then
      if not p_merge_imported then raise exception 'This Facebook publication was imported separately. Confirm merging the imported record.' using errcode='23505'; end if;
      if imported.status<>'published' or nullif(btrim(imported.title),'') is not null
        or btrim(coalesce(imported.caption,''))<>btrim(coalesce(nullif(previous.caption,''),previous.title,'')) then
        raise exception 'The existing record is not a matching imported post. Review that record instead.' using errcode='55000'; end if;
      if previous.campaign_id is not null and imported.campaign_id is not null and previous.campaign_id<>imported.campaign_id then
        raise exception 'The imported post has a different campaign. Align the campaigns in Posts before merging.' using errcode='55000'; end if;
      insert into public.marketing_reconciled_imports(imported_post_id,kept_post_id,actor_user_id,snapshot)
        values(imported.id,p_post_id,p_actor,to_jsonb(imported));
      delete from public.posts where id=imported.id;
    end if;
    update public.posts set status='published',provider_ids=coalesce(imported.provider_ids,'{}'::jsonb)||provider_ids||jsonb_build_object('facebook',p_facebook_id,'permalink',p_permalink),
      campaign_id=coalesce(previous.campaign_id,imported.campaign_id),
      media=case when jsonb_array_length(previous.media)>0 then previous.media else coalesce(imported.media,previous.media) end,
      likes=coalesce(imported.likes,previous.likes),comments=coalesce(imported.comments,previous.comments),shares=coalesce(imported.shares,previous.shares),
      reach=coalesce(imported.reach,previous.reach),views=coalesce(imported.views,previous.views),impressions=coalesce(imported.impressions,previous.impressions),
      clicks=coalesce(imported.clicks,previous.clicks),reactions=coalesce(imported.reactions,previous.reactions),saves=coalesce(imported.saves,previous.saves),
      metrics_refreshed_at=coalesce(imported.metrics_refreshed_at,previous.metrics_refreshed_at),
      published_at=p_published_at,last_error=null where id=p_post_id returning * into result;
  elsif p_resolution='draft' then
    if not coalesce(p_confirmed_absent,false) or age_start>now()-interval '10 minutes' then
      raise exception 'Wait ten minutes and confirm the post is absent from Facebook before returning it to draft' using errcode='55000'; end if;
    if nullif(previous.provider_ids->>'facebook','') is not null then raise exception 'This post already has a Facebook receipt' using errcode='55000'; end if;
    update public.posts set status='draft',publish_at=null,publish_started_at=null,last_error=null,provider_ids=provider_ids-'facebook'-'permalink' where id=p_post_id returning * into result;
  else raise exception 'Choose Published or Draft' using errcode='22023'; end if;
  insert into public.audit_log(actor_id,action,entity_type,entity_id,details)
    values(p_actor,'reconciled','post',p_post_id::text,jsonb_build_object('actor_name',(select display_name from public.profiles where id=p_actor),
      'status',result.status,'resolution',p_resolution,'note',btrim(p_note),'publish_started_at',previous.publish_started_at,
      'facebook_post_id',p_facebook_id,'merged_import_id',imported.id,'previous_status',previous.status));
  update public.user_notifications set read_at=coalesce(read_at,now()) where kind='marketing_publish_unknown' and target_record_id=p_post_id;
  return to_jsonb(result);
end;
$$;
revoke all on function public.complete_marketing_reconciliation(uuid,timestamptz,timestamptz,text,text,text,timestamptz,uuid,text,boolean,boolean) from public,anon,authenticated;
grant execute on function public.complete_marketing_reconciliation(uuid,timestamptz,timestamptz,text,text,text,timestamptz,uuid,text,boolean,boolean) to service_role;

create function public.prevent_unresolved_marketing_post_delete()
returns trigger language plpgsql set search_path='' as $$
begin
  if old.status in('publishing','publish_unknown') then raise exception 'Reconcile this publishing attempt before deleting the post' using errcode='55000'; end if;
  return old;
end;
$$;
revoke all on function public.prevent_unresolved_marketing_post_delete() from public,anon,authenticated;
create trigger posts_prevent_unresolved_delete before delete on public.posts for each row execute function public.prevent_unresolved_marketing_post_delete();
notify pgrst,'reload schema';
