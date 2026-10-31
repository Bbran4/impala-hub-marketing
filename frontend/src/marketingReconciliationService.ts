import type { Post } from "./marketingTypes";
import { requireSupabase } from "./supabase";
import { jsonBody, marketingRequest } from "./serviceTransport";
export type FacebookMatch = {
  id: string;
  permalink: string;
  published_at: string;
  message: string;
};
export type ReconciliationQueue = { posts: Post[]; page_id: string | null };
export async function loadReconciliationQueue(): Promise<ReconciliationQueue> {
  const result = await requireSupabase().rpc("marketing_reconciliation_queue");
  if (result.error || !result.data)
    throw new Error(
      result.error?.message || "Could not load publishing reviews.",
    );
  return result.data as ReconciliationQueue;
}
export const findFacebookMatches = (post: Post) =>
  marketingRequest<{ matches: FacebookMatch[]; more: boolean }>(
    "/api/marketing/facebook/reconcile",
    "Find Facebook publication",
    { method: "POST", ...jsonBody({ post_id: post.id, action: "find" }) },
  );
export const reconcilePublication = (
  post: Post,
  action: "published" | "draft",
  reference: string,
  note: string,
  confirmedAbsent: boolean,
  mergeImported: boolean,
) =>
  marketingRequest<{ post: Post }>(
    "/api/marketing/facebook/reconcile",
    "Reconcile Facebook publication",
    {
      method: "POST",
      ...jsonBody({
        post_id: post.id,
        action,
        facebook_reference: reference,
        note,
        confirmed_absent: confirmedAbsent,
        merge_imported: mergeImported,
        expected_updated_at: post.updated_at,
        expected_started_at: post.publish_started_at || null,
      }),
    },
  );
