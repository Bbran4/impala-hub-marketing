-- Validate new outbound media at save/schedule time, including direct database
-- clients. Imported publications remain historical provider data, not new uploads.
create function public.validate_marketing_post_media(p_media jsonb)
returns void language plpgsql immutable set search_path='' as $$
declare image jsonb;
begin
  if p_media is null or jsonb_typeof(p_media) <> 'array' then
    raise exception 'Post images must be a list.' using errcode='22023';
  end if;
  if jsonb_array_length(p_media)>10 then
    raise exception 'A post can contain up to 10 images. Remove some images before saving.' using errcode='22023';
  end if;
  for image in select value from jsonb_array_elements(p_media) loop
    if jsonb_typeof(image)<>'object' or jsonb_typeof(image->'url') is distinct from 'string'
      or (image->>'url') !~ '^https://[^/?#@[:space:]]+([/?#][^[:space:]]*)?$' then
      raise exception 'Each image needs a public HTTPS address. Remove and upload the image again.' using errcode='22023';
    end if;
    if image->'content_type' is not null and image->'content_type'<>'null'::jsonb and image->>'content_type'<>''
      and (jsonb_typeof(image->'content_type')<>'string' or lower(image->>'content_type') not in ('image/jpeg','image/png','image/webp','image/gif')) then
      raise exception 'Choose JPG, PNG, WEBP or GIF images.' using errcode='22023';
    end if;
    if image->'size' is not null and image->'size'<>'null'::jsonb then
      if jsonb_typeof(image->'size')<>'number' then
        raise exception 'Each image must be between 1 byte and 15 MB.' using errcode='22023';
      end if;
      if (image->>'size')::numeric <= 0 or (image->>'size')::numeric > 15728640 then
        raise exception 'Each image must be between 1 byte and 15 MB.' using errcode='22023';
      end if;
    end if;
  end loop;
end $$;
revoke all on function public.validate_marketing_post_media(jsonb) from public,anon;
grant execute on function public.validate_marketing_post_media(jsonb) to authenticated,service_role;

create function public.check_marketing_outbound_media()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.status in ('draft','awaiting_approval','scheduled','failed') then
    if tg_op='INSERT' then
      perform public.validate_marketing_post_media(new.media);
    elsif new.media is distinct from old.media or
      (new.status='scheduled' and old.status is distinct from new.status) then
      perform public.validate_marketing_post_media(new.media);
    end if;
  end if;
  return new;
end $$;
revoke all on function public.check_marketing_outbound_media() from public,anon,authenticated;
create trigger check_marketing_outbound_media
before insert or update on public.posts
for each row execute function public.check_marketing_outbound_media();
