// ABOUTME: Searches published OPAS answers as readers type on the public home page.
// ABOUTME: Cancels stale requests and announces loading, error, empty, and result states accessibly.
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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

export function Search() {
  const [query, setQuery] = useState("");
  const [retryRevision, setRetryRevision] = useState(0);
  const [search, setSearch] = useState<SearchState>({
    phase: "idle",
    query: "",
    results: [],
  });
  const normalizedQuery = normalizeSearchQuery(query);

  useEffect(() => {
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
  }, [query, retryRevision]);

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

  const status = describeSearch(search, normalizedQuery);

  return (
    <form
      className="help-search"
      role="search"
      onSubmit={(event) => event.preventDefault()}
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
          id="help-search"
          name="q"
          type="search"
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          placeholder="Search the help center"
          autoComplete="off"
          enterKeyHint="search"
          aria-describedby="help-search-status"
        />
      </div>

      <div className="search-feedback" data-state={search.phase}>
        <p id="help-search-status" role="status" aria-live="polite" aria-atomic="true">
          {status}
        </p>
        {search.phase === "error" ? (
          <button type="button" className="search-retry" onClick={retrySearch}>
            Try again
          </button>
        ) : null}
      </div>

      {search.phase === "success" && search.results.length > 0 ? (
        <ul className="search-results" aria-label="Search results">
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
    </form>
  );
}
