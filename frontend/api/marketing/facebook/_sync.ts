import type { SupabaseClient } from "@supabase/supabase-js";
import { facebookGraphUrl } from "../../_lib/facebook.ts";
import { HttpError } from "../../_lib/http.ts";
import { copyFacebookMedia } from "./_media.ts";

export const SYNC_CONCURRENCY = 3;
export const SYNC_WORK_MS = 240_000;

// Drain every active worker before responding, even when another worker fails.
export async function syncPool<T, R>(
  items: T[],
  work: (item: T) => Promise<R>,
  signal: AbortSignal,
) {
  const results: Array<{ index: number; value: R }> = [],
    errors: unknown[] = [];
  let next = 0,
    stopped = false;
  await Promise.all(
    Array.from(
      { length: Math.min(SYNC_CONCURRENCY, items.length) },
      async () => {
        while (!stopped && !signal.aborted && next < items.length) {
          const index = next++;
          try {
            results.push({ index, value: await work(items[index]) });
          } catch (error) {
            errors.push(error);
            stopped = true;
          }
        }
      },
    ),
  );
  return {
    results: results
      .sort((a, b) => a.index - b.index)
      .map((result) => result.value),
    errors,
  };
}

type Attachment = {
  media?: { image?: { src?: string } };
  subattachments?: AttachmentSet;
};
type AttachmentSet = { data?: Attachment[]; paging?: { next?: string } };
export type FacebookSyncPost = {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  full_picture?: string;
  attachments?: AttachmentSet;
  likes?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
};
type ExistingPost = {
  id: string;
  media: unknown[];
  provider_ids: { facebook: string };
  metrics_refreshed_at: string | null;
  views: number | null;
  impressions: number | null;
  reach: number | null;
  clicks: number | null;
};
type GraphResult = {
  data?: unknown;
  error?: { code?: number };
  followers_count?: number;
  fan_count?: number;
};
class SyncPaused extends Error {}
const flatten = (set?: AttachmentSet): Attachment[] =>
  (set?.data || []).flatMap((attachment) => [
    attachment,
    ...(attachment.subattachments?.data || []),
  ]);

export async function syncFacebookPage(
  admin: SupabaseClient,
  actor: string,
  connection: { id: string; page_id: string },
  token: string,
  signal: AbortSignal,
) {
  let rateLimited = false;
  const check = () => {
    signal.throwIfAborted();
    if (rateLimited) throw new SyncPaused("Facebook request limit reached.");
  };
  const graph = async (path: string) => {
    check();
    const response = await fetch(facebookGraphUrl(path), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (response.status === 429) {
      rateLimited = true;
      await response.body?.cancel();
      throw new SyncPaused("Facebook request limit reached.");
    }
    const data = (await response.json()) as GraphResult;
    if ([4, 17, 32, 613, 80001].includes(Number(data.error?.code))) {
      rateLimited = true;
      throw new SyncPaused("Facebook request limit reached.");
    }
    return { response, data };
  };
  const credential = encodeURIComponent(token);
  const fields =
    "id,message,created_time,permalink_url,full_picture,attachments{media,subattachments},likes.limit(0).summary(true),comments.limit(0).summary(true),shares";
  const fetched = await graph(
    connection.page_id +
      "/published_posts?limit=100&fields=" +
      encodeURIComponent(fields) +
      "&access_token=" +
      credential,
  ).catch((error) => {
    if (error instanceof SyncPaused)
      throw new HttpError(
        429,
        "Facebook limited requests. Wait before refreshing again.",
      );
    throw error;
  });
  if (
    !fetched.response.ok ||
    fetched.data.error ||
    !Array.isArray(fetched.data.data)
  )
    throw new HttpError(502, "Facebook rejected the sync request.");
  const incoming = fetched.data.data.slice(0, 100) as FacebookSyncPost[];
  if (incoming.some((item) => !item || typeof item.id !== "string" || !item.id))
    throw new HttpError(502, "Facebook returned an invalid post list.");
  const posts = [...new Map(incoming.map((item) => [item.id, item])).values()];
  const existingResult = posts.length
    ? await admin
        .from("posts")
        .select(
          "id,media,provider_ids,metrics_refreshed_at,views,impressions,reach,clicks",
        )
        .in(
          "provider_ids->>facebook",
          posts.map((item) => item.id),
        )
    : { data: [], error: null };
  if (existingResult.error)
    throw new HttpError(500, "Could not load existing Facebook posts.");
  const existing = new Map(
    ((existingResult.data as ExistingPost[]) || []).map((post) => [
      post.provider_ids.facebook,
      post,
    ]),
  );
  // Prioritize posts not completed by the previous refresh.
  posts.sort((a, b) =>
    (existing.get(a.id)?.metrics_refreshed_at || "").localeCompare(
      existing.get(b.id)?.metrics_refreshed_at || "",
    ),
  );
  let audience: number | null = null;
  try {
    const page = await graph(
      "me?fields=id,name,followers_count&access_token=" + credential,
    );
    if (page.response.ok && !page.data.error)
      audience = page.data.followers_count ?? page.data.fan_count ?? null;
    if (audience != null)
      await admin
        .from("provider_connections")
        .update({ followers_count: audience })
        .eq("id", connection.id);
  } catch {
    /* Optional audience data must not discard the post list. */
  }
  const pool = await syncPool(
    posts,
    async (item) => {
      check();
      const previous = existing.get(item.id);
      let attachments = flatten(item.attachments);
      const incomplete =
        item.attachments?.paging?.next ||
        item.attachments?.data?.some((a) => a.subattachments?.paging?.next) ||
        (!attachments.some((attachment) => attachment.media?.image?.src) &&
          item.full_picture);
      if (incomplete) {
        try {
          const extra = await graph(
            encodeURIComponent(item.id) +
              "/attachments?fields=media,subattachments&access_token=" +
              credential,
          );
          if (
            extra.response.ok &&
            !extra.data.error &&
            Array.isArray(extra.data.data)
          ) {
            const expanded = flatten({ data: extra.data.data as Attachment[] });
            if (expanded.length) attachments = expanded;
          }
        } catch (error) {
          check();
          if (error instanceof SyncPaused) throw error;
        }
      }
      const urls = attachments.flatMap((attachment) =>
        attachment.media?.image?.src ? [attachment.media.image.src] : [],
      );
      if (!urls.length && item.full_picture) urls.push(item.full_picture);
      const copied = await copyFacebookMedia(
        admin,
        item.id,
        urls,
        Array.isArray(previous?.media) ? previous.media : [],
        signal,
      );
      const insights: Record<string, number> = {};
      let metricsUnavailable = 0;
      const metricsErrors: string[] = [];
      const metricFallbacks: Array<[string, string[]]> = [
        ["views", ["post_media_view", "post_impressions"]],
        ["reach", ["post_total_media_view_unique", "post_impressions_unique"]],
        ["clicks", ["post_clicks"]],
      ];
      for (const [target, names] of metricFallbacks)
        for (const metric of names) {
          if (insights[target] != null) break;
          check();
          try {
            const result = await graph(
              encodeURIComponent(item.id) +
                "/insights?metric=" +
                metric +
                "&access_token=" +
                credential,
            );
            const rows = result.data.data as
              | Array<{ values?: Array<{ value?: unknown }> }>
              | undefined;
            const raw = Array.isArray(rows)
              ? rows[0]?.values?.[0]?.value
              : undefined;
            const value =
              raw && typeof raw === "object"
                ? Object.values(raw).reduce<number>(
                    (sum, entry) => sum + Number(entry || 0),
                    0,
                  )
                : Number(raw);
            if (
              !result.response.ok ||
              result.data.error ||
              raw == null ||
              !Number.isFinite(value)
            ) {
              metricsUnavailable++;
              metricsErrors.push(metric + ": HTTP " + result.response.status);
            } else insights[target] = value;
          } catch (error) {
            check();
            if (error instanceof SyncPaused) throw error;
            metricsUnavailable++;
          }
        }
      check();
      const saved = await admin.rpc("sync_facebook_post", {
        p_actor: actor,
        p_values: {
          caption: item.message || "",
          channels: ["facebook"],
          status: "published",
          published_at: item.created_time,
          media: copied.media,
          provider_ids: {
            facebook: item.id,
            ...(item.permalink_url ? { permalink: item.permalink_url } : {}),
          },
          likes: item.likes?.summary?.total_count || 0,
          comments: item.comments?.summary?.total_count || 0,
          shares: item.shares?.count || 0,
          views: insights.views ?? previous?.views ?? null,
          impressions: insights.views ?? previous?.impressions ?? null,
          reach: insights.reach ?? previous?.reach ?? null,
          clicks: insights.clicks ?? previous?.clicks ?? null,
          metrics_refreshed_at: new Date().toISOString(),
        },
      });
      signal.throwIfAborted();
      if (saved.error)
        throw new HttpError(
          saved.error.code === "PGRST202" ? 503 : 500,
          saved.error.code === "PGRST202"
            ? "The Marketing database update is missing. Check the Supabase GitHub migration results."
            : "Could not save imported Facebook post.",
        );
      return {
        imported: previous ? 0 : 1,
        metricsUnavailable,
        metricsErrors,
        mediaUnavailable: copied.unavailable,
      };
    },
    signal,
  );
  const fatal = pool.errors.find(
    (error) => !(error instanceof SyncPaused) && error !== signal.reason,
  );
  if (fatal) throw fatal;
  const partial =
    signal.aborted || rateLimited || pool.results.length < posts.length;
  let syncedAt: string | undefined;
  if (!partial) {
    syncedAt = new Date().toISOString();
    const completed = await admin
      .from("provider_connections")
      .update({ last_synced_at: syncedAt })
      .eq("id", connection.id)
      .select("id")
      .maybeSingle();
    if (completed.error || !completed.data)
      throw new HttpError(
        500,
        "Facebook posts were refreshed, but the last-update time could not be saved. Please refresh again.",
      );
  }
  return {
    status: partial ? "partial" : "synced",
    items: pool.results.reduce((sum, r) => sum + r.imported, 0),
    fetched: posts.length,
    processed: pool.results.length,
    remaining: posts.length - pool.results.length,
    metricsUnavailable: pool.results.reduce(
      (sum, r) => sum + r.metricsUnavailable,
      0,
    ),
    metricsErrors: pool.results.flatMap((r) => r.metricsErrors).slice(0, 3),
    mediaUnavailable: pool.results.reduce(
      (sum, r) => sum + r.mediaUnavailable,
      0,
    ),
    audience,
    syncedAt,
    ...(partial
      ? {
          detail: rateLimited
            ? "Facebook limited requests. Wait before refreshing again."
            : "The refresh reached its time limit. Refresh again to continue.",
        }
      : {}),
  };
}
