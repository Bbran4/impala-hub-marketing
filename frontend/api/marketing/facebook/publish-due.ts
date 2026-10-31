import { withApiErrors, requireMethod } from "../../_lib/http.ts";
import { requireCron } from "../../_lib/auth.ts";
import { serverSettings, requireSettings } from "../../_lib/config.ts";
import { createAdminClient } from "../../_lib/supabase.ts";
import { claimPost, publishClaimed, publishingBudget } from "./_publishing.js";
export default withApiErrors(async (req, res) => {
  requireMethod(req, ["GET", "POST"]);
  requireCron(req);
  const settings = serverSettings();
  requireSettings(
    settings,
    ["url", "serviceRoleKey", "encryptionKey"],
    "Scheduled publishing configuration is incomplete.",
  );
  const admin = createAdminClient(settings),
    encryptionKey = settings.encryptionKey;
  try {
    const deadline = Date.now() + 240_000;
    const now = new Date().toISOString();
    const recovered = await admin
      .from("posts")
      .update({
        status: "publish_unknown",
        last_error:
          "Interrupted publication. Check Facebook and reconcile before retrying.",
      })
      .eq("status", "publishing")
      .lt(
        "publish_started_at",
        new Date(Date.now() - 10 * 60_000).toISOString(),
      );
    if (recovered.error) throw recovered.error;
    const { data: due, error } = await admin
      .from("posts")
      .select("id,media")
      .eq("status", "scheduled")
      .lte("publish_at", now)
      .order("publish_at")
      .order("id")
      .limit(25);
    if (error) throw error;
    const connection = await admin
      .from("provider_connections")
      .select("*")
      .eq("provider", "facebook")
      .eq("is_workspace_connection", true)
      .maybeSingle();
    if (connection.error) throw connection.error;
    const results = [];
    for (const candidate of due || []) {
      // Leave time to finish and persist the in-flight publication.
      if (Date.now() + publishingBudget(candidate.media) > deadline) break;
      const post = await claimPost(
        admin,
        candidate.id,
        ["scheduled"],
        undefined,
        now,
      );
      if (post)
        results.push(
          await publishClaimed(
            admin,
            post,
            connection.data,
            encryptionKey,
            deadline,
          ),
        );
    }
    return res.status(200).json({ processed: results.length, results });
  } catch {
    return res.status(500).json({
      detail:
        "Scheduled publication could not be completed. Check post statuses before retrying.",
    });
  }
});
