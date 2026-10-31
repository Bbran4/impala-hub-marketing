-- Supabase owns the frequent timer; Vercel only executes the authenticated job.
-- Plain PostgreSQL test environments may not ship the Supabase extensions.
do $$ begin
  if exists(select 1 from pg_available_extensions where name='pg_cron') then
    create extension if not exists pg_cron;
  end if;
  if exists(select 1 from pg_available_extensions where name='pg_net') then
    create extension if not exists pg_net;
  end if;
end $$;
create schema if not exists app_private;
revoke all on schema app_private from public,anon,authenticated;

create function app_private.marketing_publish_request_settings()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare token text; base_url text;
begin
  if to_regclass('vault.decrypted_secrets') is null then return null; end if;
  select s.decrypted_secret into token from vault.decrypted_secrets s
    where s.name in('marketing_publish_cron_secret','report_emails_cron_secret')
    order by case s.name when 'marketing_publish_cron_secret' then 0 else 1 end limit 1;
  if nullif(btrim(token),'') is null then return null; end if;
  select s.decrypted_secret into base_url from vault.decrypted_secrets s where s.name='marketing_publish_base_url' limit 1;
  base_url:=rtrim(coalesce(nullif(btrim(base_url),''),'https://impala-hub-marketing.vercel.app'),'/');
  if base_url !~ '^https://[a-zA-Z0-9][a-zA-Z0-9.-]*(:443)?$' then
    raise exception 'Marketing scheduler needs an HTTPS application origin' using errcode='22023';
  end if;
  return jsonb_build_object('url',base_url||'/api/marketing/facebook/publish-due',
    'headers',jsonb_build_object('Authorization','Bearer '||token,'Content-Type','application/json'));
end;
$$;
create function app_private.dispatch_marketing_publish_due()
returns bigint language plpgsql security definer set search_path='' as $$
declare config jsonb; request_id bigint;
begin
  config:=app_private.marketing_publish_request_settings();
  if config is null then
    raise warning 'Marketing scheduler has no Vault cron secret. Configure marketing_publish_cron_secret or report_emails_cron_secret.';
    return null;
  end if;
  -- pg_net is asynchronous; do not cancel a valid publishing run after 5 seconds.
  select net.http_post(url:=config->>'url',headers:=config->'headers',body:='{}'::jsonb,
    timeout_milliseconds:=295000) into request_id;
  return request_id;
end;
$$;
revoke all on function app_private.marketing_publish_request_settings(),app_private.dispatch_marketing_publish_due() from public,anon,authenticated;

create function public.marketing_publish_scheduler_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare config jsonb; enabled boolean:=false;
begin
  if not public.can_manage_app_settings() then raise exception 'Administrator settings access required' using errcode='42501'; end if;
  config:=app_private.marketing_publish_request_settings();
  if to_regclass('cron.job') is not null then
    select exists(select 1 from cron.job where jobname='marketing-publish-due' and active) into enabled;
  end if;
  return jsonb_build_object('configured',config is not null,'active',enabled,'schedule','*/2 * * * *',
    'url',config->>'url');
end;
$$;
revoke all on function public.marketing_publish_scheduler_status() from public,anon;
grant execute on function public.marketing_publish_scheduler_status() to authenticated;

do $$ begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null and to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null then
    perform cron.schedule('marketing-publish-due','*/2 * * * *','select app_private.dispatch_marketing_publish_due();');
  else
    raise notice 'pg_cron/pg_net are unavailable in this database; Marketing timer was not installed.';
  end if;
end $$;
notify pgrst,'reload schema';
