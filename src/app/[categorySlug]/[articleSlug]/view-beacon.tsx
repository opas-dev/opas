// ABOUTME: Records a privacy-light view when a published article renders in the browser.
// ABOUTME: Sends one anonymous best-effort request for each article navigation without cookies.
"use client";

import { useEffect, useRef } from "react";

type ArticleViewBeaconProps = {
  articleId: string;
};

export function ArticleViewBeacon({ articleId }: ArticleViewBeaconProps) {
  const recordedArticleId = useRef<string | null>(null);

  useEffect(() => {
    if (recordedArticleId.current === articleId) {
      return;
    }

    recordedArticleId.current = articleId;

    void fetch(`/api/articles/${encodeURIComponent(articleId)}/view`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
  }, [articleId]);

  return null;
}
