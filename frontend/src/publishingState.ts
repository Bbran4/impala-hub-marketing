import type { Post } from "./marketingTypes";
export const PUBLISHING_LABELS: Record<string, string> = {
  publishing: "Publishing",
  publish_unknown: "Needs review",
};
export const isPublishingRisk = (status: string) =>
  status === "publishing" || status === "publish_unknown";
export const postStatusLabel = (status: string) =>
  PUBLISHING_LABELS[status] || status.replace(/_/g, " ");
export const publishingMessage = (status: string) =>
  status === "publishing"
    ? "Publication is in progress. Do not submit this post again."
    : "Facebook may already have accepted this post. An administrator must review the outcome before it can be retried.";
export function canReviewPublication(post: Post, now = Date.now()) {
  if (post.status === "publish_unknown") return true;
  const started = Date.parse(
    post.publish_started_at || post.updated_at || post.created_at || "",
  );
  return (
    post.status === "publishing" &&
    Number.isFinite(started) &&
    now - started >= 600_000
  );
}
export function canReturnPublicationToDraft(post: Post, now = Date.now()) {
  const started = Date.parse(
    post.publish_started_at || post.updated_at || post.created_at || "",
  );
  return (
    isPublishingRisk(post.status) &&
    Number.isFinite(started) &&
    now - started >= 600_000 &&
    !post.provider_ids?.facebook
  );
}
