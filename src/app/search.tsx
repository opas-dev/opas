// ABOUTME: Gives readers one entry point for search and cited answers from published content.
// ABOUTME: Streams bounded follow-ups with accessible cancellation, retry, and source states.
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { AnswerMarkdown } from "@/app/answer-markdown";
import {
  AnswerStreamError,
  consumeAnswerResponse,
  conversationHistory,
  describeAnswerFailure,
  isValidCurrentPageContext,
  type AnswerFailureCode,
  type AnswerStreamSnapshot,
  type CompletedAnswerTurn,
  type CurrentPageContext,
} from "@/app/answer-stream";

import {
  constrainSearchInput,
  minimumSearchQueryLength,
  normalizeSearchQuery,
  searchQueryLength,
} from "@/search/query";

type SearchResult = {
  id: string;
  title: string;
  href: string;
  category: string;
  excerpt: string;
};

type SearchResponse = {
  query: string;
  results: SearchResult[];
};

type SearchState = {
  phase: "idle" | "loading" | "success" | "error";
  query: string;
  results: SearchResult[];
};

const searchDelay = 300;
const maximumConversationQuestions = 4;
const defaultSuggestedQuestions = [
  "How do I get started?",
  "How can I customize the help center?",
] as const;

type SearchProps = Readonly<{
  currentPage?: CurrentPageContext;
  suggestedQuestions?: readonly string[];
}>;

type AssistantTurn = Omit<AnswerStreamSnapshot, "phase"> &
  Readonly<{
    id: number;
    phase: "loading" | AnswerStreamSnapshot["phase"];
    question: string;
  }>;

type ActiveAnswer = {
  controller: AbortController;
  id: number;
};

function pendingTurn(id: number, question: string): AssistantTurn {
  return {
    abstention: null,
    blocks: [],
    failure: null,
    finish: null,
    id,
    metadata: null,
    phase: "loading",
    question,
  };
}

function completedTurn(turn: AssistantTurn): CompletedAnswerTurn | null {
  if (turn.phase === "complete") {
    return {
      answer: turn.blocks.flatMap(({ markdown }) => markdown).join("\n\n"),
      question: turn.question,
    };
  }
  if (turn.phase === "abstained" && turn.abstention) {
    return { answer: turn.abstention.message, question: turn.question };
  }
  return null;
}

function answerStatus(turn: AssistantTurn | undefined) {
  if (!turn) return "Ask a question to get an answer from published content.";
  if (turn.phase === "loading") return "Finding published sources…";
  if (turn.phase === "streaming") {
    return turn.blocks.length > 0
      ? `Answering with ${turn.blocks.length} verified ${turn.blocks.length === 1 ? "source" : "sources"}…`
      : "Reading the strongest published sources…";
  }
  if (turn.phase === "complete") {
    return `Answer complete with ${turn.blocks.length} cited ${turn.blocks.length === 1 ? "source" : "sources"}.`;
  }
  if (turn.phase === "abstained") return "No reliable answer was available.";
  return describeAnswerFailure(turn.failure ?? "unavailable").message;
}

function isSearchResult(value: unknown): value is SearchResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const result = value as Partial<SearchResult>;
  return (
    typeof result.id === "string" &&
    typeof result.title === "string" &&
    typeof result.href === "string" &&
    typeof result.category === "string" &&
    typeof result.excerpt === "string"
  );
}

function isSearchResponse(value: unknown): value is SearchResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const response = value as Partial<SearchResponse>;
  return (
    typeof response.query === "string" &&
    Array.isArray(response.results) &&
    response.results.every(isSearchResult)
  );
}

function describeSearch(state: SearchState, query: string) {
  if (state.phase === "loading") {
    return "Searching published answers…";
  }

  if (state.phase === "error") {
    return "Search is temporarily unavailable.";
  }

  if (state.phase === "success") {
    const count = state.results.length;
    if (count === 0) {
      return `No published answers matched “${state.query}”. Try a different word or phrase.`;
    }

    return `${count} published ${count === 1 ? "answer" : "answers"} found.`;
  }

  if (query.length === 0) {
    return "Search across all published answers.";
  }

  return "Enter at least 2 characters to search.";
}

export function Search({
  currentPage,
  suggestedQuestions = defaultSuggestedQuestions,
}: SearchProps = {}) {
  const [query, setQuery] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [retryRevision, setRetryRevision] = useState(0);
  const [search, setSearch] = useState<SearchState>({
    phase: "idle",
    query: "",
    results: [],
  });
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const activeAnswer = useRef<ActiveAnswer | null>(null);
  const nextTurnId = useRef(1);
  const searchInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const normalizedQuery = normalizeSearchQuery(query);
  const activeTurn = turns.find(
    ({ phase }) => phase === "loading" || phase === "streaming",
  );
  const latestTurn = turns.at(-1);
  const conversationStarted = turns.length > 0;
  const safeCurrentPage = isValidCurrentPageContext(currentPage)
    ? currentPage
    : undefined;
  const suggestions = Array.from(
    new Set(
      suggestedQuestions
        .map((question) => normalizeSearchQuery(constrainSearchInput(question)))
        .filter(
          (question) =>
            searchQueryLength(question) >= minimumSearchQueryLength &&
            searchQueryLength(question) <= 200,
        ),
    ),
  ).slice(0, 3);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeAnswer.current?.controller.abort();
    };
  }, []);

  useEffect(() => {
    if (conversationStarted) return;
    const requestedQuery = normalizeSearchQuery(query);
    if (searchQueryLength(requestedQuery) < minimumSearchQueryLength) {
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void fetch(`/api/search?q=${encodeURIComponent(requestedQuery)}`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal: controller.signal,
      })
        .then(async (response) => {
          const body: unknown = await response.json();
          if (!response.ok || !isSearchResponse(body)) {
            throw new Error("Search response was invalid.");
          }

          setSearch((current) =>
            current.query === requestedQuery
              ? { phase: "success", query: body.query, results: body.results }
              : current,
          );
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === "AbortError") {
            return;
          }

          setSearch((current) =>
            current.query === requestedQuery
              ? { phase: "error", query: requestedQuery, results: [] }
              : current,
          );
        });
    }, searchDelay);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [conversationStarted, query, retryRevision]);

  function updateQuery(nextQuery: string) {
    const constrainedQuery = constrainSearchInput(nextQuery);
    const requestedQuery = normalizeSearchQuery(constrainedQuery);
    setQuery(constrainedQuery);
    setSearch({
      phase:
        searchQueryLength(requestedQuery) >= minimumSearchQueryLength ? "loading" : "idle",
      query: requestedQuery,
      results: [],
    });
  }

  function retrySearch() {
    setSearch({ phase: "loading", query: normalizedQuery, results: [] });
    setRetryRevision((revision) => revision + 1);
  }

  function replaceTurn(id: number, update: AssistantTurn | AnswerStreamSnapshot) {
    if (!mounted.current) return;
    setTurns((current) =>
      current.map((turn) =>
        turn.id === id
          ? "id" in update
            ? update
            : { ...update, id, question: turn.question }
          : turn,
      ),
    );
  }

  function requestAnswer(questionValue: string, retryId?: number) {
    if (activeAnswer.current) return;
    const question = normalizeSearchQuery(constrainSearchInput(questionValue));
    if (searchQueryLength(question) < minimumSearchQueryLength) return;

    const retryIndex =
      retryId === undefined ? -1 : turns.findIndex(({ id }) => id === retryId);
    const priorTurns = (retryIndex >= 0 ? turns.slice(0, retryIndex) : turns)
      .map(completedTurn)
      .filter((turn): turn is CompletedAnswerTurn => turn !== null);
    const history = conversationHistory(priorTurns);
    const id = retryIndex >= 0 ? turns[retryIndex]!.id : nextTurnId.current++;
    const pending = pendingTurn(id, question);
    if (retryIndex >= 0) {
      replaceTurn(id, pending);
    } else {
      setTurns((current) => [...current, pending]);
    }
    setFollowUp("");

    const controller = new AbortController();
    activeAnswer.current = { controller, id };
    void (async () => {
      try {
        const response = await fetch("/api/answers", {
          body: JSON.stringify({
            ...(safeCurrentPage ? { currentPagePath: safeCurrentPage.path } : {}),
            ...(history.length > 0 ? { history } : {}),
            question,
          }),
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            accept: "application/x-ndjson",
            "content-type": "application/json; charset=utf-8",
          },
          method: "POST",
          signal: controller.signal,
        });
        const result = await consumeAnswerResponse(response, {
          onSnapshot: (snapshot) => {
            if (activeAnswer.current?.id === id) replaceTurn(id, snapshot);
          },
          signal: controller.signal,
        });
        if (activeAnswer.current?.id === id) replaceTurn(id, result);
      } catch (error) {
        const failure: AnswerFailureCode = controller.signal.aborted
          ? "cancelled"
          : error instanceof AnswerStreamError
            ? error.code
            : "disconnected";
        if (activeAnswer.current?.id === id) {
          setTurns((current) =>
            current.map((turn) =>
              turn.id === id
                ? { ...turn, failure, phase: "error" as const }
                : turn,
            ),
          );
        }
      } finally {
        if (activeAnswer.current?.id === id) activeAnswer.current = null;
      }
    })();
  }

  function stopAnswer() {
    const request = activeAnswer.current;
    if (!request) return;
    request.controller.abort();
    setTurns((current) =>
      current.map((turn) =>
        turn.id === request.id
          ? { ...turn, failure: "cancelled" as const, phase: "error" as const }
          : turn,
      ),
    );
  }

  function startOver() {
    if (activeAnswer.current) return;
    setTurns([]);
    setQuery("");
    setFollowUp("");
    setSearch({ phase: "idle", query: "", results: [] });
    window.requestAnimationFrame(() => searchInput.current?.focus());
  }

  const status = describeSearch(search, normalizedQuery);
  const assistantStatus = answerStatus(latestTurn);

  return (
    <section className="help-search" aria-label="Help center search and answers">
      {!conversationStarted ? (
        <>
          <form
            className="search-form"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              requestAnswer(query);
            }}
          >
            <label htmlFor="help-search">What can we help you find?</label>
            <div className="search-field">
              <svg
                className="search-icon"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <circle cx="8.5" cy="8.5" r="5.5" />
                <path d="m12.5 12.5 4 4" />
              </svg>
              <input
                ref={searchInput}
                id="help-search"
                name="q"
                type="search"
                value={query}
                onChange={(event) => updateQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    requestAnswer(query);
                  }
                }}
                placeholder="Search or ask a question"
                autoComplete="off"
                enterKeyHint="send"
                aria-describedby="help-search-status"
                aria-controls="help-search-results"
              />
              <button
                type="submit"
                className="answer-submit"
                disabled={searchQueryLength(normalizedQuery) < minimumSearchQueryLength}
              >
                Ask
              </button>
            </div>

            <div className="search-feedback" data-state={search.phase}>
              <p
                id="help-search-status"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {status}
              </p>
              {search.phase === "error" ? (
                <button type="button" className="search-retry" onClick={retrySearch}>
                  Retry search
                </button>
              ) : null}
            </div>
          </form>

          {safeCurrentPage ? (
            <p className="answer-context">
              Using this published page as context: <strong>{safeCurrentPage.title}</strong>
            </p>
          ) : null}

          {normalizedQuery.length === 0 && suggestions.length > 0 ? (
            <div className="suggested-questions" aria-labelledby="suggested-questions-label">
              <p id="suggested-questions-label">Suggested questions</p>
              <ul>
                {suggestions.map((question) => (
                  <li key={question}>
                    <button
                      type="button"
                      onClick={() => {
                        setQuery(question);
                        requestAnswer(question);
                      }}
                    >
                      {question}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {search.phase === "success" && search.results.length > 0 ? (
            <ul
              id="help-search-results"
              className="search-results"
              aria-label="Search results"
            >
              {search.results.map((result) => (
                <li key={result.id}>
                  <Link href={result.href} aria-label={`${result.title}, ${result.category}`}>
                    <span className="search-result-heading">
                      <span className="search-result-title">{result.title}</span>
                      <span className="search-result-category">{result.category}</span>
                    </span>
                    {result.excerpt ? (
                      <span className="search-result-excerpt">{result.excerpt}</span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <section
          className="answer-conversation"
          aria-labelledby="answer-conversation-heading"
          aria-busy={Boolean(activeTurn)}
        >
          <header className="answer-heading">
            <div>
              <p>AI-assisted · Published sources only</p>
              <h2 id="answer-conversation-heading">Cited answer</h2>
            </div>
            <button type="button" onClick={startOver} disabled={Boolean(activeTurn)}>
              New question
            </button>
          </header>

          {safeCurrentPage ? (
            <p className="answer-context">
              Page context: <strong>{safeCurrentPage.title}</strong>
            </p>
          ) : null}

          <ol className="answer-turns" aria-label="Assistant conversation">
            {turns.map((turn, turnIndex) => (
              <li key={turn.id}>
                <article aria-labelledby={`answer-question-${turn.id}`}>
                  <h3 id={`answer-question-${turn.id}`}>
                    <span>Question {turnIndex + 1}</span>
                    {turn.question}
                  </h3>

                  {turn.phase === "loading" && turn.blocks.length === 0 ? (
                    <div className="answer-skeleton" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                  ) : null}

                  {turn.blocks.map((block, blockIndex) => (
                    <div className="answer-block" key={`${block.citation.id}-${blockIndex}`}>
                      <div className="answer-markdown">
                        {block.markdown.map((markdown, markdownIndex) => (
                          <AnswerMarkdown
                            key={`${block.citation.id}-${markdownIndex}`}
                            markdown={markdown}
                          />
                        ))}
                      </div>
                      <a className="answer-citation" href={block.citation.canonicalUrl}>
                        <span aria-hidden="true">[{block.citation.id.slice(1)}]</span>{" "}
                        {block.citation.title}
                        {block.citation.headingPath.length > 0
                          ? ` · ${block.citation.headingPath.join(" › ")}`
                          : ""}
                      </a>
                    </div>
                  ))}

                  {turn.phase === "abstained" && turn.abstention ? (
                    <p className="answer-abstention">{turn.abstention.message}</p>
                  ) : null}

                  {turn.phase === "error" && turn.failure ? (
                    <p className="answer-error" role="alert">
                      {describeAnswerFailure(turn.failure).message}
                    </p>
                  ) : null}

                  {turn.metadata ? (
                    <p className="answer-disclosure">
                      {turn.metadata.retentionDisclosure}
                    </p>
                  ) : null}
                </article>
              </li>
            ))}
          </ol>

          <div className="answer-actions">
            {activeTurn ? (
              <button type="button" className="answer-stop" onClick={stopAnswer}>
                Stop answer
              </button>
            ) : latestTurn?.phase === "error" ? (
              <button
                type="button"
                className="answer-retry"
                onClick={() => requestAnswer(latestTurn.question, latestTurn.id)}
              >
                Retry answer
              </button>
            ) : turns.length < maximumConversationQuestions ? (
              <form
                className="answer-follow-up"
                onSubmit={(event) => {
                  event.preventDefault();
                  requestAnswer(followUp);
                }}
              >
                <label htmlFor="answer-follow-up">Ask a follow-up</label>
                <div>
                  <input
                    id="answer-follow-up"
                    type="search"
                    value={followUp}
                    onChange={(event) => setFollowUp(constrainSearchInput(event.target.value))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        requestAnswer(followUp);
                      }
                    }}
                    placeholder="Ask about the cited answer"
                    autoComplete="off"
                    enterKeyHint="send"
                    aria-describedby="answer-conversation-status answer-follow-up-limit"
                  />
                  <button
                    type="submit"
                    disabled={
                      searchQueryLength(normalizeSearchQuery(followUp)) <
                      minimumSearchQueryLength
                    }
                  >
                    Ask follow-up
                  </button>
                </div>
                <span id="answer-follow-up-limit">
                  {maximumConversationQuestions - turns.length} follow-up
                  {maximumConversationQuestions - turns.length === 1 ? "" : "s"} remaining
                </span>
              </form>
            ) : (
              <p className="answer-limit">
                Follow-up limit reached. Start a new question to continue.
              </p>
            )}
          </div>

          <p
            id="answer-conversation-status"
            className="answer-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {assistantStatus}
          </p>
        </section>
      )}
    </section>
  );
}
