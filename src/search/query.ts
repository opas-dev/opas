// ABOUTME: Defines one normalized Unicode query contract for the search UI and API.
// ABOUTME: Counts and truncates user input by code point instead of UTF-16 code unit.
export const minimumSearchQueryLength = 2;
export const maximumSearchQueryLength = 200;

export function normalizeSearchQuery(query: string) {
  return query.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function searchQueryLength(query: string) {
  return Array.from(query).length;
}

export function constrainSearchInput(query: string) {
  const normalized = normalizeSearchQuery(query);
  const constrained = Array.from(normalized).slice(0, maximumSearchQueryLength).join("");
  const preservesTypingSpace =
    constrained.length > 0 &&
    searchQueryLength(constrained) < maximumSearchQueryLength &&
    /\s$/u.test(query);

  return preservesTypingSpace ? `${constrained} ` : constrained;
}
