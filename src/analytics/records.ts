// ABOUTME: Creates bounded anonymous article analytics records and retention cutoffs.
// ABOUTME: Uses fixed UTC-day slots shared by Postgres, SQLite, and Cloudflare D1.
import type { ArticleView, Feedback } from "@/db/repository";

export const articleEventSlotsPerDay = 1_024;
export const articleEventRetentionDays = 30;

const millisecondsPerDay = 86_400_000;

export type ArticleEventCreationOptions = {
  now?: () => Date;
  random?: () => number;
};

function eventSlot(random: () => number) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("Article event randomness must be at least 0 and less than 1.");
  }

  return String(Math.floor(value * articleEventSlotsPerDay)).padStart(4, "0");
}

function eventIdentity(
  kind: "article_feedback" | "article_view",
  articleId: string,
  eventAt: Date,
  random: () => number,
) {
  const day = eventAt.toISOString().slice(0, 10).replaceAll("-", "");
  return `${kind}_${articleId}_${day}_${eventSlot(random)}`;
}

export function createArticleView(
  articleId: string,
  { now = () => new Date(), random = Math.random }: ArticleEventCreationOptions = {},
): ArticleView {
  const viewedAt = now();
  return {
    id: eventIdentity("article_view", articleId, viewedAt, random),
    articleId,
    viewedAt,
  };
}

export function createArticleFeedback(
  articleId: string,
  feedback: Pick<Feedback, "helpful" | "comment">,
  { now = () => new Date(), random = Math.random }: ArticleEventCreationOptions = {},
): Feedback {
  const createdAt = now();
  return {
    id: eventIdentity("article_feedback", articleId, createdAt, random),
    articleId,
    helpful: feedback.helpful,
    comment: feedback.comment ?? null,
    createdAt,
  };
}

export function articleEventRetentionStart(eventAt: Date) {
  return new Date(eventAt.getTime() - articleEventRetentionDays * millisecondsPerDay);
}
