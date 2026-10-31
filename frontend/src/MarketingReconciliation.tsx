import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { startVisiblePolling } from "./visiblePolling";
import { fmt, headingOf } from "./lib";
import {
  canReviewPublication,
  canReturnPublicationToDraft,
  postStatusLabel,
  publishingMessage,
} from "./publishingState";
import {
  findFacebookMatches,
  loadReconciliationQueue,
  reconcilePublication,
  type FacebookMatch,
  type ReconciliationQueue,
} from "./marketingReconciliationService";

export default function MarketingReconciliation({
  setNotice,
  setError,
  focusPostId,
}: {
  setNotice: (message: string) => void;
  setError: (message: string) => void;
  focusPostId?: string;
}) {
  const [queue, setQueue] = useState<ReconciliationQueue>({
    posts: [],
    page_id: null,
  });
  const [selectedId, setSelectedId] = useState(focusPostId || "");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [mergeImported, setMergeImported] = useState(false);
  const [confirmedAbsent, setConfirmedAbsent] = useState(false);
  const [matches, setMatches] = useState<FacebookMatch[] | null>(null);
  const [moreMatches, setMoreMatches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      setQueue(await loadReconciliationQueue());
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [setError]);
  useEffect(() => startVisiblePolling(() => load(), 30_000), [load]);
  const post =
    queue.posts.find((item) => item.id === selectedId) || queue.posts[0];
  const currentPostId = useRef("");
  currentPostId.current = post?.id || "";
  useEffect(() => {
    setMergeImported(false);
    setReference("");
    setNote("");
    setConfirmedAbsent(false);
    setMatches(null);
    setMoreMatches(false);
  }, [post?.id, post?.publish_started_at]);
  async function find() {
    if (!post || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await findFacebookMatches(post);
      if (currentPostId.current !== post.id) return;
      setMatches(result.matches);
      setMoreMatches(result.more);
      if (result.matches.length === 1) setReference(result.matches[0].id);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function resolve(action: "published" | "draft") {
    if (!post || busy) return;
    if (
      action === "draft" &&
      !window.confirm(
        "Return this post to draft? Only continue if you checked the Facebook Page and confirmed it was not published. Publishing it again could otherwise create a duplicate.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await reconcilePublication(
        post,
        action,
        reference,
        note,
        confirmedAbsent,
        mergeImported,
      );
      setNotice(
        action === "published"
          ? "Facebook publication verified and linked."
          : "Post returned to draft. It has not been republished.",
      );
      await load();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="admin-settings-panel marketing-reconciliation">
      <div className="section-head">
        <div>
          <h2>Publishing review</h2>
          <p>
            In-progress and uncertain publications across all months and pages.
            Administrator reviews are recorded in post history.
          </p>
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {loading ? (
        <p className="hint">Loading publishing attempts…</p>
      ) : !post ? (
        <p className="hint">No publications need review.</p>
      ) : (
        <>
          <label>
            Publishing attempt
            <select
              value={post.id}
              disabled={busy}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {queue.posts.map((item) => (
                <option key={item.id} value={item.id}>
                  {headingOf(item)} — {postStatusLabel(item.status)}
                </option>
              ))}
            </select>
          </label>
          <div className="publishing-warning">
            <AlertTriangle size={18} />
            <div>
              <b>{postStatusLabel(post.status)}</b>
              <p>{publishingMessage(post.status)}</p>
              <small>
                Started {fmt(post.publish_started_at || post.updated_at)}
              </small>
            </div>
          </div>
          <p className="reconcile-caption">{post.caption || post.title}</p>
          <div className="reconcile-preview">
            {(Array.isArray(post.media) ? post.media : []).map((item) => (
              <a href={item.url} key={item.id} target="_blank" rel="noreferrer">
                <img src={item.url} alt={item.name} />
              </a>
            ))}
          </div>
          {post.last_error && <p className="hint">{post.last_error}</p>}
          {queue.page_id && (
            <a
              className="text-button"
              href={`https://www.facebook.com/${encodeURIComponent(queue.page_id)}`}
              target="_blank"
              rel="noreferrer"
            >
              Open the connected Facebook Page
            </a>
          )}
          {!canReviewPublication(post) ? (
            <p className="hint">
              This attempt is still running. Review becomes available after ten
              minutes if it has not completed.
            </p>
          ) : (
            <>
              <div className="reconcile-published">
                <h3>Confirm an existing Facebook publication</h3>
                <p>
                  Find posts with matching content and timing, or paste the
                  Facebook post link or ID. Facebook is checked again before the
                  result is saved.
                </p>
                <button
                  className="secondary"
                  disabled={busy || !queue.page_id}
                  onClick={() => void find()}
                >
                  Find matching Facebook posts
                </button>
                {matches && (
                  <div className="reconcile-matches">
                    {matches.map((match) => (
                      <label key={match.id}>
                        <input
                          type="radio"
                          name="facebook-match"
                          checked={reference === match.id}
                          disabled={busy}
                          onChange={() => setReference(match.id)}
                        />
                        <span>
                          {fmt(match.published_at)}{" "}
                          <a
                            href={match.permalink}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View on Facebook
                          </a>
                        </span>
                      </label>
                    ))}
                    {!matches.length && (
                      <p>
                        No matching post was found in the checked results. Check
                        the Facebook Page before deciding it was not published.
                      </p>
                    )}
                    {moreMatches && (
                      <p>
                        Facebook has more results. You can use the exact post
                        link or ID if it is outside this batch.
                      </p>
                    )}
                  </div>
                )}
                <label className="reconcile-confirm">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={mergeImported}
                    onChange={(event) => setMergeImported(event.target.checked)}
                  />
                  If sync imported this publication separately, merge that
                  imported copy into this original post. Keep the original title
                  and owner; retain any existing campaign assignment and archive
                  the imported record.
                </label>
                <label>
                  Facebook post link or ID
                  <input
                    value={reference}
                    disabled={busy}
                    onChange={(event) => setReference(event.target.value)}
                  />
                </label>
                <button
                  className="primary"
                  disabled={busy || !reference.trim()}
                  onClick={() => void resolve("published")}
                >
                  {busy ? "Checking…" : "Verify and mark published"}
                </button>
              </div>
              <div className="reconcile-draft">
                <h3>Return an unpublished attempt to draft</h3>
                <p>
                  This does not publish anything. Wait at least ten minutes,
                  inspect the Page, and confirm the post is absent before
                  allowing another attempt.
                </p>
                <label className="reconcile-confirm">
                  <input
                    type="checkbox"
                    checked={confirmedAbsent}
                    disabled={busy || !canReturnPublicationToDraft(post)}
                    onChange={(event) =>
                      setConfirmedAbsent(event.target.checked)
                    }
                  />
                  I checked the Facebook Page and confirmed this post was not
                  published.
                </label>
                <label>
                  Review note
                  <textarea
                    value={note}
                    disabled={busy}
                    maxLength={1000}
                    rows={2}
                    placeholder="Describe what you checked"
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
                <button
                  className="secondary"
                  disabled={
                    busy ||
                    !confirmedAbsent ||
                    note.trim().length < 10 ||
                    !canReturnPublicationToDraft(post)
                  }
                  onClick={() => void resolve("draft")}
                >
                  Return to draft after review
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
