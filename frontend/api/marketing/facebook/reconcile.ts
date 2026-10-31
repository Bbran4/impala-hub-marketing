import { withApiErrors, requireMethod, HttpError } from "../../_lib/http.ts";
import { requireMarketingSession } from "../../_lib/auth.ts";
import { decryptToken } from "../../_lib/metaCrypto.ts";
import {
  findFacebookPublications,
  verifyFacebookPublication,
} from "./_reconciliation.ts";

export default withApiErrors(async (req, res) => {
  requireMethod(req, ["POST"]);
  const { admin, user, settings } = await requireMarketingSession(
    req,
    "reconcile",
    { required: ["encryptionKey"] },
  );
  const body = req.body || {};
  const id = String(body.post_id || "");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw new HttpError(400, "Choose a post to reconcile.");
  const result = await admin
    .from("posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (result.error)
    throw new HttpError(500, "Could not load the publishing attempt.");
  const post = result.data;
  if (!post) throw new HttpError(404, "Post not found.");
  if (!["publishing", "publish_unknown"].includes(post.status))
    throw new HttpError(
      409,
      "This post no longer needs reconciliation. Reload the queue.",
    );
  if (!["find", "published", "draft"].includes(String(body.action)))
    throw new HttpError(400, "Choose a reconciliation action.");
  let verified;
  if (body.action !== "draft") {
    const connection = await admin
      .from("provider_connections")
      .select("page_id,token_ciphertext")
      .eq("provider", "facebook")
      .eq("is_workspace_connection", true)
      .maybeSingle();
    if (
      connection.error ||
      !connection.data?.page_id ||
      !connection.data.token_ciphertext
    )
      throw new HttpError(
        409,
        "Connect Facebook before checking a publication.",
      );
    const context = {
      pageId: connection.data.page_id,
      token: decryptToken(
        connection.data.token_ciphertext,
        settings.encryptionKey,
      ),
      caption: post.caption || post.title || "",
      startedAt: post.publish_started_at,
    };
    if (body.action === "find")
      return res.status(200).json(await findFacebookPublications(context));
    verified = await verifyFacebookPublication(
      String(body.facebook_reference || ""),
      context,
    );
  }
  const note = String(
    body.note ||
      (verified ? "Verified against the connected Facebook Page." : ""),
  ).trim();
  if (note.length < 10 || note.length > 1000)
    throw new HttpError(
      400,
      "Add a review note between 10 and 1000 characters.",
    );
  if (
    typeof body.expected_updated_at !== "string" ||
    !Number.isFinite(Date.parse(body.expected_updated_at)) ||
    (body.expected_started_at != null &&
      (typeof body.expected_started_at !== "string" ||
        !Number.isFinite(Date.parse(body.expected_started_at))))
  )
    throw new HttpError(
      400,
      "Reload the publishing attempt before reconciling.",
    );
  const saved = await admin.rpc("complete_marketing_reconciliation", {
    p_post_id: id,
    p_expected_updated_at: body.expected_updated_at,
    p_expected_started_at: body.expected_started_at || null,
    p_resolution: body.action,
    p_facebook_id: verified?.id || null,
    p_permalink: verified?.permalink || null,
    p_published_at: verified?.published_at || null,
    p_actor: user.id,
    p_note: note,
    p_confirmed_absent: body.confirmed_absent === true,
    p_merge_imported: body.merge_imported === true,
  });
  if (saved.error) {
    if (["40001", "55000", "23505"].includes(saved.error.code))
      throw new HttpError(
        409,
        saved.error.code === "23505"
          ? "This Facebook publication is already linked. Confirm merging its imported record, or review the existing authored post."
          : saved.error.message,
      );
    if (saved.error.code === "22023")
      throw new HttpError(400, saved.error.message);
    throw new HttpError(
      500,
      "Reconciliation could not be saved. Reload before trying again.",
    );
  }
  return res.status(200).json({ post: saved.data });
});
