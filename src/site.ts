// ABOUTME: Defines OPAS's public identity, deployment origin, and safe URL path helpers.
// ABOUTME: Keeps canonical and agent-readable links identical on every deployment target.
export const siteName = "OPAS Help Center";
export const siteDescription = "A help center you can theme, deploy, and own.";
export const sitePublisherName = "OPAS";

const localSiteOrigin = "http://localhost:3000";
const publicSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function invalidSiteOrigin(): never {
  throw new Error(
    "OPAS_SITE_URL must be an HTTP(S) origin without credentials, a path, query, or fragment",
  );
}

export function resolveSiteOrigin(
  configuredUrl: string | undefined = process.env.OPAS_SITE_URL,
) {
  const candidate = configuredUrl?.trim();

  if (!candidate) {
    return localSiteOrigin;
  }

  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    return invalidSiteOrigin();
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return invalidSiteOrigin();
  }

  return url.origin;
}

export function isPublicSlug(value: string) {
  return publicSlugPattern.test(value);
}

export function publicCategoryPath(categorySlug: string) {
  return isPublicSlug(categorySlug) ? `/${categorySlug}` : null;
}

export function publicArticlePath(categorySlug: string, articleSlug: string) {
  if (!isPublicSlug(categorySlug) || !isPublicSlug(articleSlug)) {
    return null;
  }

  return `/${categorySlug}/${articleSlug}`;
}

export function publicArticleMarkdownPath(categorySlug: string, articleSlug: string) {
  const path = publicArticlePath(categorySlug, articleSlug);
  return path ? `${path}.md` : null;
}

export function absoluteSiteUrl(path: string, configuredUrl?: string) {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Public site URLs require a safe root-relative path");
  }

  const origin = resolveSiteOrigin(configuredUrl);
  const url = new URL(path, `${origin}/`);

  if (url.origin !== origin || url.pathname !== path) {
    throw new Error("Public site URLs must remain on the configured origin and path");
  }

  return url.toString();
}
