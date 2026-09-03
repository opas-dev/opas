// ABOUTME: Renders one authorized immutable article revision without public discovery features.
// ABOUTME: Shows persistent private context while omitting search, analytics, and publication metadata.

import type { Metadata } from "next";
import { cookies } from "next/headers";

import { ArticlePreviewEntry } from "@/app/preview/preview-entry";
import { resolveArticlePreview } from "@/auth/article-preview";
import { getArticlePreviewRepository } from "@/auth/article-preview-database";
import { articlePreviewCookieName } from "@/auth/preview-claims";
import { getArticlePreviewConfiguration } from "@/auth/preview-config";
import { RuntimeMdx } from "@/content/runtime-mdx";
import { publicSiteIdentity } from "@/site";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { follow: false, index: false, nocache: true },
  title: "Private article preview",
};

const dateTimeFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

async function loadArticlePreview() {
  try {
    const configuration = getArticlePreviewConfiguration();
    const token = (await cookies()).get(
      articlePreviewCookieName(configuration.deploymentId),
    )?.value;
    return resolveArticlePreview(token, configuration, {
      repository: await getArticlePreviewRepository(),
    });
  } catch {
    return null;
  }
}

export default async function ArticlePreviewPage() {
  const preview = await loadArticlePreview();
  if (!preview) return <ArticlePreviewEntry />;

  const identity = publicSiteIdentity();
  return (
    <>
      <a className="skip-link" href="#preview-article">
        Skip to article
      </a>
      <aside
        aria-label="Private preview details"
        className="sticky top-0 z-20 border-b border-border bg-background text-foreground"
      >
        <div className="mx-auto flex min-h-16 w-full max-w-[74rem] flex-wrap items-center justify-between gap-x-8 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="grid size-8 place-items-center rounded-sm bg-warning text-xs font-bold text-warning-foreground"
            >
              P
            </span>
            <div>
              <p className="m-0 text-sm font-bold">Private preview</p>
              <p className="m-0 text-xs leading-5 text-muted">
                {identity.productName} · Revision {preview.revisionNumber}
              </p>
            </div>
          </div>
          <dl className="m-0 flex flex-wrap gap-x-6 gap-y-1 text-xs leading-5 text-muted">
            <div className="flex gap-1.5">
              <dt className="font-semibold text-foreground">Saved</dt>
              <dd className="m-0">
                <time dateTime={preview.revisionSavedAt.toISOString()}>
                  {dateTimeFormatter.format(preview.revisionSavedAt)} UTC
                </time>
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="font-semibold text-foreground">Expires</dt>
              <dd className="m-0">
                <time dateTime={preview.expiresAt.toISOString()}>
                  {dateTimeFormatter.format(preview.expiresAt)} UTC
                </time>
              </dd>
            </div>
          </dl>
        </div>
      </aside>
      <main className="article-shell" id="preview-article">
        <nav className="article-nav" aria-label="Preview location">
          <span>{identity.productName}</span>
          <span aria-hidden="true">/</span>
          <span>{preview.categoryName}</span>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{preview.title}</span>
        </nav>
        {preview.remoteImageHosts.length > 0 ? (
          <p className="mt-6 max-w-[64ch] rounded-md border border-border bg-surface px-4 py-3 text-sm leading-6 text-muted">
            This revision loads images from {preview.remoteImageHosts.join(", ")}.
            Those services can observe the viewer’s IP address and request timing.
          </p>
        ) : null}
        <article className="article-content">
          <RuntimeMdx source={preview.mdx} />
          <footer className="article-meta">
            <span>Written by {preview.authorName}</span>
            <span>Private revision {preview.revisionNumber}</span>
          </footer>
        </article>
      </main>
    </>
  );
}
