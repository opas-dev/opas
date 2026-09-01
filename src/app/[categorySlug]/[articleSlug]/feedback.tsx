// ABOUTME: Collects an anonymous helpfulness response and optional comment on a public article.
// ABOUTME: Exposes complete accessible pending, success, and retry states for the feedback request.
"use client";

import type { FormEvent } from "react";
import { useState } from "react";

import { maximumFeedbackCommentLength } from "@/analytics/limits";

type ArticleFeedbackProps = {
  articleId: string;
};

type Helpfulness = "yes" | "no";
type SubmissionState = "idle" | "submitting" | "success" | "error";

const fallbackError = "We couldn’t save your feedback. Please try again.";

export function ArticleFeedback({ articleId }: ArticleFeedbackProps) {
  const [helpfulness, setHelpfulness] = useState<Helpfulness | null>(null);
  const [comment, setComment] = useState("");
  const [submissionState, setSubmissionState] = useState<SubmissionState>("idle");
  const [errorMessage, setErrorMessage] = useState(fallbackError);
  const commentLength = Array.from(comment).length;
  const remainingCharacters = maximumFeedbackCommentLength - commentLength;

  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!helpfulness || submissionState === "submitting") {
      return;
    }

    setSubmissionState("submitting");

    try {
      const trimmedComment = comment.trim();
      const response = await fetch(
        `/api/articles/${encodeURIComponent(articleId)}/feedback`,
        {
          method: "POST",
          cache: "no-store",
          credentials: "omit",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            helpful: helpfulness === "yes",
            ...(trimmedComment ? { comment: trimmedComment } : {}),
          }),
        },
      );

      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as
          | { error?: unknown }
          | null;
        setErrorMessage(
          typeof result?.error === "string" ? result.error : fallbackError,
        );
        setSubmissionState("error");
        return;
      }

      setSubmissionState("success");
    } catch {
      setErrorMessage(fallbackError);
      setSubmissionState("error");
    }
  }

  return (
    <section className="article-feedback" aria-labelledby="article-feedback-heading">
      <h2 id="article-feedback-heading">Was this helpful?</h2>
      {submissionState === "success" ? (
        <p className="article-feedback-success" role="status" aria-live="polite">
          Thanks—your feedback helps improve this answer.
        </p>
      ) : (
        <form onSubmit={submitFeedback}>
          <fieldset disabled={submissionState === "submitting"}>
            <legend className="sr-only">Choose whether this article was helpful</legend>
            <div className="article-feedback-options">
              <label className="article-feedback-option">
                <input
                  type="radio"
                  name="helpful"
                  value="yes"
                  checked={helpfulness === "yes"}
                  onChange={() => {
                    setHelpfulness("yes");
                    setSubmissionState("idle");
                  }}
                />
                Yes
              </label>
              <label className="article-feedback-option">
                <input
                  type="radio"
                  name="helpful"
                  value="no"
                  checked={helpfulness === "no"}
                  onChange={() => {
                    setHelpfulness("no");
                    setSubmissionState("idle");
                  }}
                />
                No
              </label>
            </div>

            {helpfulness ? (
              <div className="article-feedback-detail">
                <label className="article-feedback-comment" htmlFor="article-feedback-comment">
                  <span>
                    Add a note <span className="article-feedback-optional">Optional</span>
                  </span>
                  <textarea
                    aria-describedby="article-feedback-comment-limit"
                    id="article-feedback-comment"
                    name="comment"
                    rows={3}
                    value={comment}
                    onChange={(event) => {
                      setComment(
                        Array.from(event.target.value)
                          .slice(0, maximumFeedbackCommentLength)
                          .join(""),
                      );
                      if (submissionState === "error") {
                        setSubmissionState("idle");
                      }
                    }}
                    placeholder="What could make this guide clearer?"
                  />
                  <span
                    aria-live={remainingCharacters <= 20 ? "polite" : "off"}
                    className="article-feedback-comment-limit"
                    data-limit={remainingCharacters === 0 ? "true" : undefined}
                    id="article-feedback-comment-limit"
                  >
                    {remainingCharacters === 0
                      ? "Character limit reached."
                      : `${remainingCharacters.toLocaleString("en-US")} characters remaining.`}
                  </span>
                </label>

                <div className="article-feedback-actions">
                  <button
                    type="submit"
                    disabled={submissionState === "submitting"}
                    data-pending={submissionState === "submitting" ? "true" : undefined}
                  >
                    {submissionState === "submitting" ? "Sending…" : "Send feedback"}
                  </button>
                  <p className="article-feedback-status" aria-live="polite">
                    {submissionState === "error" ? (
                      <span role="alert">{errorMessage}</span>
                    ) : (
                      "No personal details are required."
                    )}
                  </p>
                </div>
              </div>
            ) : (
              <p className="article-feedback-prompt">Choose yes or no to share feedback.</p>
            )}
          </fieldset>
        </form>
      )}
    </section>
  );
}
