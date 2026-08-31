// ABOUTME: Renders the isolated assistant document and accepts only its configured parent window.
// ABOUTME: Resolves bounded page URLs server-side before sharing published context with search.
"use client";

import { useEffect, useRef, useState } from "react";

import { Search } from "@/app/search";
import {
  isPublishedPageIdentity,
  type PublishedPageIdentity,
} from "@/content/page-context";
import {
  isParentContextMessageEvent,
  maximumEmbedHeight,
  minimumEmbedHeight,
  type EmbedControlMessage,
} from "@/embed/messages";

type EmbedAssistantProps = Readonly<{
  parentOrigin: string;
}>;

type ContextState = Readonly<{
  context: PublishedPageIdentity | null;
  handoffPageUrl: string | null;
  phase: "error" | "ready" | "resolving" | "waiting";
}>;

function parsedContextResponse(value: unknown): PublishedPageIdentity | null | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !("context" in record)) {
    return undefined;
  }
  return record.context === null || isPublishedPageIdentity(record.context)
    ? record.context
    : undefined;
}

export function EmbedAssistant({ parentOrigin }: EmbedAssistantProps) {
  const [state, setState] = useState<ContextState>({
    context: null,
    handoffPageUrl: null,
    phase: "waiting",
  });
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    if (window.parent === window) return;
    let disposed = false;
    let lastHeight = 0;

    const send = (message: EmbedControlMessage) => {
      window.parent.postMessage(message, parentOrigin);
    };
    const reportHeight = () => {
      const height = Math.min(
        maximumEmbedHeight,
        Math.max(minimumEmbedHeight, Math.ceil(document.documentElement.scrollHeight)),
      );
      if (height === lastHeight) return;
      lastHeight = height;
      send({ height, type: "opas:resize", version: 1 });
    };
    const receiveContext = (event: MessageEvent) => {
      if (!isParentContextMessageEvent(event, parentOrigin, window.parent)) return;

      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      const pageUrl = new URL(event.data.pageUrl);
      pageUrl.search = "";
      pageUrl.hash = "";
      const handoffPageUrl = pageUrl.toString();
      setState({ context: null, handoffPageUrl, phase: "resolving" });
      void fetch("/api/embed/context", {
        body: JSON.stringify({
          pageUrl: event.data.pageUrl,
          parentOrigin,
        }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json; charset=utf-8",
        },
        method: "POST",
        signal: controller.signal,
      })
        .then(async (response) => {
          const value: unknown = await response.json();
          const context = parsedContextResponse(value);
          if (!response.ok || context === undefined) {
            throw new Error("Embed page context response was invalid");
          }
          if (!disposed && activeRequest.current === controller) {
            setState({ context, handoffPageUrl, phase: "ready" });
          }
        })
        .catch((error: unknown) => {
          if (
            !disposed &&
            activeRequest.current === controller &&
            !(error instanceof Error && error.name === "AbortError")
          ) {
            setState({ context: null, handoffPageUrl, phase: "error" });
          }
        })
        .finally(() => {
          if (activeRequest.current === controller) activeRequest.current = null;
        });
    };

    window.addEventListener("message", receiveContext);
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(reportHeight)
        : null;
    observer?.observe(document.body);
    send({ type: "opas:ready", version: 1 });
    reportHeight();

    return () => {
      disposed = true;
      activeRequest.current?.abort();
      activeRequest.current = null;
      observer?.disconnect();
      window.removeEventListener("message", receiveContext);
    };
  }, [parentOrigin]);

  const loading = state.phase === "waiting" || state.phase === "resolving";
  const status =
    state.phase === "waiting"
      ? "Connecting securely to this page…"
      : state.phase === "resolving"
        ? "Checking for matching published page context…"
        : state.phase === "error"
          ? "Page context is unavailable. You can still ask across published content."
          : state.context
            ? `Using published page context: ${state.context.title}`
            : "No matching published page was found. Searching all published content.";

  return (
    <main className="embed-shell" aria-labelledby="embed-heading" aria-busy={loading}>
      <header className="embed-heading">
        <p>AI-assisted · Published sources only</p>
        <h1 id="embed-heading">Ask the help center</h1>
        <span>Get a concise answer with links back to the source.</span>
      </header>
      <p className="embed-context-status" role="status" aria-live="polite" aria-atomic="true">
        {status}
      </p>
      {!loading ? (
        <Search
          citationNavigation="new-tab"
          key={state.context?.articleId ?? "all-published-content"}
          currentPage={state.context ?? undefined}
          handoffPageUrl={state.handoffPageUrl ?? undefined}
        />
      ) : null}
    </main>
  );
}
