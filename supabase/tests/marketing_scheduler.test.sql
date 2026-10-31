begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
-- The real Supabase test stack has Vault. A plain PostgreSQL fallback can use
-- this transaction-local stand-in; no dispatcher or external request is invoked.
do $$ begin
  if to_regclass('vault.decrypted_secrets') is null then
    create schema if not exists vault;
    create table vault.decrypted_secrets(name text,decrypted_secret text);
    execute $ddl$create function vault.create_secret(secret text,secret_name text) returns uuid language plpgsql as $fn$
      begin insert into vault.decrypted_secrets values(secret_name,secret);return gen_random_uuid();end; $fn$ $ddl$;
  end if;
end $$;
insert into auth.users(id,email,raw_user_meta_data) values
('11300000-0000-0000-0000-000000000001','scheduler-admin@test.invalid','{}'),
('11300000-0000-0000-0000-000000000002','scheduler-employee@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values('11300000-0000-0000-0000-000000000001','administrator');
select ok(not has_schema_privilege('authenticated','app_private','usage'),'browser cannot access private scheduler functions');
select ok(not has_function_privilege('anon','public.marketing_publish_scheduler_status()','execute'),'anonymous users cannot inspect scheduler configuration');
select vault.create_secret('reporting-test-token','report_emails_cron_secret');
select is(app_private.marketing_publish_request_settings()->'headers'->>'Authorization','Bearer reporting-test-token','Reporting Vault token is reused');
select is(app_private.marketing_publish_request_settings()->>'url','https://impala-hub-marketing.vercel.app/api/marketing/facebook/publish-due','scheduler targets the production publishing handler');
select vault.create_secret('marketing-test-token','marketing_publish_cron_secret');
select is(app_private.marketing_publish_request_settings()->'headers'->>'Authorization','Bearer marketing-test-token','dedicated Marketing token takes precedence');
set local role authenticated;
set local request.jwt.claims='{"sub":"11300000-0000-0000-0000-000000000001","role":"authenticated"}';
select ok((public.marketing_publish_scheduler_status()->>'configured')::boolean,'administrator can verify configured state');
select is(public.marketing_publish_scheduler_status()->>'schedule','*/2 * * * *','publishing uses the two-minute schedule');
select ok(not(public.marketing_publish_scheduler_status() ? 'headers'),'status never returns request authorization');
select throws_ok($sql$select app_private.dispatch_marketing_publish_due()$sql$,'42501',null,'browser cannot dispatch scheduled work');
set local request.jwt.claims='{"sub":"11300000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($sql$select public.marketing_publish_scheduler_status()$sql$,'42501',null,'employee cannot inspect scheduler settings');
reset role;
select vault.create_secret('http://untrusted.example','marketing_publish_base_url');
select throws_ok($sql$select app_private.marketing_publish_request_settings()$sql$,'22023',null,'scheduler refuses an insecure application origin');
select * from finish();
rollback;
