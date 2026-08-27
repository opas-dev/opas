// ABOUTME: Serves normalized keyword searches over the demo workspace's published articles.
// ABOUTME: Records zero-result queries while keeping database failures out of API responses.
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";
import { createSearchMiss } from "@/db/search-misses";
import { searchPublishedArticles } from "@/search/articles";
import {
  maximumSearchQueryLength,
  minimumSearchQueryLength,
  normalizeSearchQuery,
  searchQueryLength,
} from "@/search/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SearchResponseResult = {
  id: string;
  title: string;
  category: string;
  href: string;
  excerpt: string;
};

type SearchResponse = {
  query: string;
  results: SearchResponseResult[];
  error: string | null;
};

const responseHeaders = {
  "Cache-Control": "no-store",
};

function searchResponse(body: SearchResponse, status = 200) {
  return Response.json(body, { status, headers: responseHeaders });
}

function databaseErrorDetails(error: unknown) {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;

  return {
    type: error instanceof Error ? error.name : "UnknownError",
    code,
  };
}

export async function GET(request: Request) {
  const query = normalizeSearchQuery(new URL(request.url).searchParams.get("q") ?? "");
  const queryLength = searchQueryLength(query);

  if (queryLength > maximumSearchQueryLength) {
    return searchResponse(
      {
        query,
        results: [],
        error: "Search queries must be 200 characters or fewer.",
      },
      400,
    );
  }

  if (queryLength < minimumSearchQueryLength) {
    return searchResponse({ query, results: [], error: null });
  }

  try {
    const repository = await getRepository();
    const [articles, categories] = await Promise.all([
      repository.listPublishedArticles(demoIds.workspace),
      repository.listCategories(demoIds.workspace),
    ]);
    const searchResults = await searchPublishedArticles({ articles, categories, query });
    const results = searchResults.map((result) => ({
      id: result.articleId,
      title: result.title,
      category: result.categoryName,
      href: result.href,
      excerpt: result.excerpt,
    }));

    if (results.length === 0) {
      try {
        await repository.recordSearchMiss(createSearchMiss(demoIds.workspace, query));
      } catch (error) {
        console.error("Search miss persistence failed.", databaseErrorDetails(error));
      }
    }

    return searchResponse({ query, results, error: null });
  } catch (error) {
    console.error("Search request failed.", databaseErrorDetails(error));
    return searchResponse(
      {
        query,
        results: [],
        error: "Search is temporarily unavailable.",
      },
      500,
    );
  }
}
