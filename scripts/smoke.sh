#!/usr/bin/env bash
# ABOUTME: Runs portable read-only HTTP smoke checks against an OPAS deployment.
# ABOUTME: Verifies health, published discovery surfaces, and missing-route isolation with useful failures.

set -uo pipefail

smoke_usage() {
  printf 'Usage: %s <http-or-https-base-url>\n' "${0##*/}" >&2
}

if [[ $# -ne 1 ]]; then
  smoke_usage
  exit 64
fi

if ! command -v curl >/dev/null 2>&1; then
  printf 'ERROR: curl is required to run the OPAS smoke checks.\n' >&2
  exit 69
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'ERROR: Node.js 22 or newer is required to parse smoke-check responses.\n' >&2
  exit 69
fi

smoke_node_major=$(node -p 'process.versions.node.split(".")[0]')
if [[ ! "$smoke_node_major" =~ ^[0-9]+$ ]] || ((smoke_node_major < 22)); then
  printf 'ERROR: Node.js 22 or newer is required; found %s.\n' "$(node --version)" >&2
  exit 69
fi

smoke_base_url=$1
while [[ "$smoke_base_url" == */ ]]; do
  smoke_base_url=${smoke_base_url%/}
done

if [[ -z "$smoke_base_url" || "$smoke_base_url" == *[[:space:]]* ]]; then
  printf 'ERROR: base URL must be one HTTP(S) origin without whitespace.\n' >&2
  smoke_usage
  exit 64
fi

if ! smoke_base_url=$(node -e '
  const input = process.argv[1];
  let url;
  try {
    url = new URL(input);
  } catch {
    process.exit(1);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    process.exit(1);
  }
  process.stdout.write(url.origin);
' "$smoke_base_url"); then
  printf 'ERROR: base URL must be an HTTP(S) origin without credentials, a path, query, or fragment.\n' >&2
  smoke_usage
  exit 64
fi

smoke_tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/opas-smoke.XXXXXX") || {
  printf 'ERROR: could not create a temporary directory.\n' >&2
  exit 73
}

smoke_cleanup() {
  if [[ -n "${smoke_tmp_dir:-}" && -d "$smoke_tmp_dir" ]]; then
    rm -rf -- "$smoke_tmp_dir"
  fi
}

trap smoke_cleanup EXIT

smoke_request_index=0
smoke_response_status=""
smoke_curl_status=0
smoke_response_headers=""
smoke_response_body=""
smoke_response_error=""
smoke_request_url=""
smoke_parser_error=""

smoke_request() {
  local smoke_path=$1

  smoke_request_index=$((smoke_request_index + 1))
  smoke_request_url="${smoke_base_url}${smoke_path}"
  smoke_response_headers="${smoke_tmp_dir}/headers-${smoke_request_index}.txt"
  smoke_response_body="${smoke_tmp_dir}/body-${smoke_request_index}.txt"
  smoke_response_error="${smoke_tmp_dir}/curl-${smoke_request_index}.txt"
  smoke_parser_error=""

  smoke_response_status=$(curl \
    --silent \
    --show-error \
    --request GET \
    --connect-timeout 5 \
    --max-time 20 \
    --user-agent "OPAS-Smoke/0.1" \
    --dump-header "$smoke_response_headers" \
    --output "$smoke_response_body" \
    --write-out '%{http_code}' \
    "$smoke_request_url" \
    2>"$smoke_response_error")
  smoke_curl_status=$?

  return "$smoke_curl_status"
}

smoke_fail() {
  local smoke_expectation=$1

  printf '\nERROR: %s\n' "$smoke_expectation" >&2
  printf 'URL: %s\n' "$smoke_request_url" >&2
  printf 'HTTP status: %s\n' "${smoke_response_status:-not received}" >&2
  if [[ $smoke_curl_status -ne 0 ]]; then
    printf 'curl exit status: %s\n' "$smoke_curl_status" >&2
  fi
  if [[ -s "$smoke_response_error" ]]; then
    printf '%s\n' '--- curl error ---' >&2
    awk 'NR <= 20 { print substr($0, 1, 500) }' "$smoke_response_error" >&2
  fi
  if [[ -s "$smoke_response_headers" ]]; then
    printf '%s\n' '--- response headers ---' >&2
    awk 'NR <= 40 { print substr($0, 1, 500) }' "$smoke_response_headers" >&2
  fi
  if [[ -s "$smoke_response_body" ]]; then
    printf '%s\n' '--- response body excerpt ---' >&2
    awk 'NR <= 40 { print substr($0, 1, 500) }' "$smoke_response_body" >&2
  fi
  if [[ -n "$smoke_parser_error" && -s "$smoke_parser_error" ]]; then
    printf '%s\n' '--- parser error ---' >&2
    awk 'NR <= 20 { print substr($0, 1, 500) }' "$smoke_parser_error" >&2
  fi
  exit 1
}

smoke_pass() {
  printf 'PASS  %s\n' "$1"
}

smoke_expect_get() {
  local smoke_label=$1
  local smoke_path=$2
  local smoke_expected_status=$3

  if ! smoke_request "$smoke_path"; then
    smoke_fail "$smoke_label request must complete successfully"
  fi
  if [[ "$smoke_response_status" != "$smoke_expected_status" ]]; then
    smoke_fail "$smoke_label must return HTTP $smoke_expected_status"
  fi
}

smoke_require_body() {
  local smoke_label=$1
  local smoke_expected_text=$2

  if ! grep -Fq -- "$smoke_expected_text" "$smoke_response_body"; then
    smoke_fail "$smoke_label response body must contain: $smoke_expected_text"
  fi
}

smoke_require_header() {
  local smoke_label=$1
  local smoke_expected_text=$2

  if ! grep -Fiq -- "$smoke_expected_text" "$smoke_response_headers"; then
    smoke_fail "$smoke_label response headers must contain: $smoke_expected_text"
  fi
}

smoke_discover_article() {
  local smoke_output_path=$1
  local smoke_output_url=$2
  local smoke_output_origin=$3

  smoke_parser_error="${smoke_tmp_dir}/parser-${smoke_request_index}.txt"
  if ! node - \
    "$smoke_response_body" \
    "$smoke_output_path" \
    "$smoke_output_url" \
    "$smoke_output_origin" \
    2>"$smoke_parser_error" <<'NODE'
const fs = require("node:fs");

const sitemapPath = process.argv[2];
const outputPath = process.argv[3];
const outputUrl = process.argv[4];
const outputOrigin = process.argv[5];
const xml = fs.readFileSync(sitemapPath, "utf8");
const decodeXml = (value) =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
const locations = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/giu)].map((match) =>
  decodeXml(match[1].trim()),
);
const article = locations
  .map((location) => {
    try {
      return new URL(location);
    } catch {
      return null;
    }
  })
  .find(
    (url) =>
      url !== null &&
      ["http:", "https:"].includes(url.protocol) &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.split("/").filter(Boolean).length === 2 &&
      !url.pathname.endsWith(".md"),
  );

if (!article) {
  console.error("Sitemap does not contain a valid published two-level article URL.");
  process.exit(1);
}

fs.writeFileSync(outputPath, article.pathname);
fs.writeFileSync(outputUrl, article.href);
fs.writeFileSync(outputOrigin, article.origin);
NODE
  then
    smoke_fail "sitemap must expose a valid published two-level article"
  fi
}

smoke_extract_article_contract() {
  local smoke_expected_path=$1
  local smoke_expected_url=$2
  local smoke_headline_path=$3
  local smoke_markdown_headline_path=$4
  local smoke_query_path=$5

  smoke_parser_error="${smoke_tmp_dir}/parser-${smoke_request_index}.txt"
  if ! node - \
    "$smoke_response_body" \
    "$smoke_expected_path" \
    "$smoke_expected_url" \
    "$smoke_headline_path" \
    "$smoke_markdown_headline_path" \
    "$smoke_query_path" \
    2>"$smoke_parser_error" <<'NODE'
const fs = require("node:fs");

const htmlPath = process.argv[2];
const expectedPath = process.argv[3];
const expectedUrl = process.argv[4];
const headlinePath = process.argv[5];
const markdownHeadlinePath = process.argv[6];
const queryPath = process.argv[7];
const html = fs.readFileSync(htmlPath, "utf8");
const canonicalTag = [...html.matchAll(/<link\b[^>]*>/giu)].find((match) =>
  /\brel=["']canonical["']/iu.test(match[0]),
);
const canonical = canonicalTag?.[0].match(/\bhref=["']([^"']+)["']/iu)?.[1];

if (canonical !== expectedUrl) {
  console.error(`Canonical URL mismatch: expected ${expectedUrl}, received ${canonical ?? "none"}.`);
  process.exit(1);
}

const jsonLdMatch = html.match(
  /<script\b[^>]*\bid=["']opas-article-jsonld["'][^>]*>([\s\S]*?)<\/script>/iu,
);
if (!jsonLdMatch) {
  console.error("Article JSON-LD script is missing.");
  process.exit(1);
}

let article;
try {
  article = JSON.parse(jsonLdMatch[1]);
} catch (error) {
  console.error(`Article JSON-LD is invalid JSON: ${error.message}`);
  process.exit(1);
}

if (article["@type"] !== "Article") {
  console.error(`Article JSON-LD @type must be Article, received ${String(article["@type"])}.`);
  process.exit(1);
}
if (typeof article.headline !== "string" || article.headline.trim() === "") {
  console.error("Article JSON-LD must contain a non-empty headline.");
  process.exit(1);
}
if (article.headline.includes("\n") || article.headline.includes("\r")) {
  console.error("The discovered article headline cannot be searched safely because it contains a line break.");
  process.exit(1);
}
if (article.mainEntityOfPage !== expectedUrl) {
  console.error(
    `Article JSON-LD mainEntityOfPage mismatch: expected ${expectedUrl}, received ${String(article.mainEntityOfPage)}.`,
  );
  process.exit(1);
}

const query = article.headline.normalize("NFKC").trim().replace(/\s+/gu, " ");
if ([...query].length < 2 || !/[\p{L}\p{N}]/u.test(query)) {
  console.error("The discovered article headline cannot form a safe two-character search query.");
  process.exit(1);
}

fs.writeFileSync(headlinePath, article.headline);
fs.writeFileSync(
  markdownHeadlinePath,
  article.headline.trim().replace(/\s+/gu, " ").replace(/([\\\[\]])/gu, "\\$1"),
);
fs.writeFileSync(queryPath, encodeURIComponent(query));
NODE
  then
    smoke_fail "article canonical and JSON-LD must match the sitemap publication"
  fi
}

smoke_validate_search_result() {
  local smoke_expected_path=$1
  local smoke_expected_headline=$2

  smoke_parser_error="${smoke_tmp_dir}/parser-${smoke_request_index}.txt"
  if ! node - \
    "$smoke_response_body" \
    "$smoke_expected_path" \
    "$smoke_expected_headline" \
    2>"$smoke_parser_error" <<'NODE'
const fs = require("node:fs");

const responsePath = process.argv[2];
const expectedPath = process.argv[3];
const expectedHeadline = process.argv[4];
let response;

try {
  response = JSON.parse(fs.readFileSync(responsePath, "utf8"));
} catch (error) {
  console.error(`Search response is invalid JSON: ${error.message}`);
  process.exit(1);
}

if (response.error !== null) {
  console.error(`Search returned an error: ${String(response.error)}.`);
  process.exit(1);
}
if (!Array.isArray(response.results)) {
  console.error("Search response does not contain a results array.");
  process.exit(1);
}
if (
  !response.results.some(
    (result) => result?.href === expectedPath && result?.title === expectedHeadline,
  )
) {
  console.error(`Search did not return the discovered article at ${expectedPath}.`);
  process.exit(1);
}
NODE
  then
    smoke_fail "searching the discovered headline must return its published article"
  fi
}

smoke_ready=0
smoke_ready_attempt=1
smoke_ready_attempts=30

while ((smoke_ready_attempt <= smoke_ready_attempts)); do
  if smoke_request "/api/health" && \
    [[ "$smoke_response_status" == "200" ]] && \
    grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "$smoke_response_body"; then
    smoke_ready=1
    break
  fi

  if ((smoke_ready_attempt < smoke_ready_attempts)); then
    sleep 1
  fi
  smoke_ready_attempt=$((smoke_ready_attempt + 1))
done

if [[ $smoke_ready -ne 1 ]]; then
  smoke_fail "deployment must become healthy within ${smoke_ready_attempts} attempts"
fi
smoke_pass "database-aware health endpoint"

smoke_expect_get "home page" "/" "200"
smoke_require_body "home page" "OPAS Help Center"
smoke_require_header "global discovery" '</llms.txt>; rel="llms-txt"'
smoke_require_header "global discovery" '</llms-full.txt>; rel="llms-full-txt"'
smoke_require_header "global discovery" "X-Llms-Txt: /llms.txt"
smoke_pass "home page and global discovery headers"

smoke_expect_get "sitemap" "/sitemap.xml" "200"
smoke_require_body "sitemap" '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
smoke_article_path_file="${smoke_tmp_dir}/article-path.txt"
smoke_article_url_file="${smoke_tmp_dir}/article-url.txt"
smoke_canonical_origin_file="${smoke_tmp_dir}/canonical-origin.txt"
smoke_discover_article \
  "$smoke_article_path_file" \
  "$smoke_article_url_file" \
  "$smoke_canonical_origin_file"
smoke_article_path=$(<"$smoke_article_path_file")
smoke_article_url=$(<"$smoke_article_url_file")
smoke_canonical_origin=$(<"$smoke_canonical_origin_file")
smoke_pass "sitemap published-article discovery"

smoke_expect_get "discovered article" "$smoke_article_path" "200"
smoke_headline_file="${smoke_tmp_dir}/article-headline.txt"
smoke_markdown_headline_file="${smoke_tmp_dir}/article-markdown-headline.txt"
smoke_query_file="${smoke_tmp_dir}/article-query.txt"
smoke_extract_article_contract \
  "$smoke_article_path" \
  "$smoke_article_url" \
  "$smoke_headline_file" \
  "$smoke_markdown_headline_file" \
  "$smoke_query_file"
smoke_article_headline=$(<"$smoke_headline_file")
smoke_markdown_headline=$(<"$smoke_markdown_headline_file")
smoke_article_query=$(<"$smoke_query_file")
smoke_pass "discovered article canonical and Article JSON-LD"

smoke_expect_get "published-article search" "/api/search?q=${smoke_article_query}" "200"
smoke_validate_search_result "$smoke_article_path" "$smoke_article_headline"
smoke_pass "published article search result"

smoke_expect_get "llms.txt" "/llms.txt" "200"
smoke_require_body "llms.txt" "# OPAS Help Center"
smoke_require_body \
  "llms.txt" \
  "${smoke_canonical_origin}${smoke_article_path}.md"
smoke_pass "compact AI index"

smoke_expect_get "llms-full.txt" "/llms-full.txt" "200"
smoke_require_body "llms-full.txt" "# ${smoke_markdown_headline}"
smoke_require_body \
  "llms-full.txt" \
  "Source: ${smoke_article_url}"
smoke_pass "full AI document"

smoke_expect_get "article Markdown" "${smoke_article_path}.md" "200"
smoke_require_header "article Markdown" "Content-Type: text/markdown; charset=utf-8"
smoke_require_header "article Markdown" "X-Robots-Tag: noindex, nofollow"
smoke_markdown_first_line=""
IFS= read -r smoke_markdown_first_line < "$smoke_response_body" || true
if [[ ! "$smoke_markdown_first_line" =~ ^#[[:space:]]+[^[:space:]] ]]; then
  smoke_fail "article Markdown must begin with a non-empty level-one heading"
fi
smoke_pass "per-article Markdown body and crawler headers"

smoke_missing_id=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
smoke_missing_path="/opas-smoke-${smoke_missing_id}/opas-smoke-${smoke_missing_id}"
smoke_expect_get \
  "guaranteed missing article" \
  "$smoke_missing_path" \
  "404"
smoke_pass "unknown two-level route remains private"

printf '\nOPAS smoke checks passed for %s\n' "$smoke_base_url"
