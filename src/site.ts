// ABOUTME: Defines deployment-selected public identities, origins, and safe URL helpers.
// ABOUTME: Keeps generic OPAS and CROFusion demos branded without sharing runtime state.
type PublicSiteEnvironment = Readonly<
  Partial<Record<"OPAS_PUBLIC_PROFILE", string | undefined>>
>;

const publicSiteIdentities = {
  opas: {
    id: "opas",
    productName: "OPAS",
    siteName: "OPAS Help Center",
    siteDescription: "A help center you can theme, deploy, and own.",
    publisherName: "OPAS",
    headerNote: "Help that stays yours",
    heroContext: "OPAS Help Center",
    heroHeading: "What can OPAS help you answer?",
    heroCopy:
      "Ask about OPAS features, authoring, deployment, and grounded answers—or browse by topic.",
  },
  crofusion: {
    id: "crofusion",
    productName: "CROFusion",
    siteName: "CROFusion Help Center",
    siteDescription:
      "Guidance for creating, publishing, and improving landing pages with CROFusion.",
    publisherName: "CROFusion",
    headerNote: "Create. Test. Convert.",
    heroContext: "CROFusion Help Center",
    heroHeading: "How can we help you convert?",
    heroCopy:
      "Ask about creating, publishing, and improving landing pages—or browse the CROFusion guides.",
  },
} as const;

export type PublicSiteIdentity =
  (typeof publicSiteIdentities)[keyof typeof publicSiteIdentities];

export function publicSiteIdentity(
  environment: PublicSiteEnvironment = {
    OPAS_PUBLIC_PROFILE: process.env.OPAS_PUBLIC_PROFILE,
  },
): PublicSiteIdentity {
  const profile = environment.OPAS_PUBLIC_PROFILE ?? "opas";

  if (profile !== "opas" && profile !== "crofusion") {
    throw new Error("OPAS_PUBLIC_PROFILE must be opas or crofusion");
  }

  return publicSiteIdentities[profile];
}

export const siteName = publicSiteIdentities.opas.siteName;
export const siteDescription = publicSiteIdentities.opas.siteDescription;
export const sitePublisherName = publicSiteIdentities.opas.publisherName;

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
