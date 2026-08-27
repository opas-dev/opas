// ABOUTME: Edits article metadata and MDX with authenticated save, preview, and delete actions.
// ABOUTME: Debounces safe server compilation so authors see the rendered answer while typing.
"use client";

import type { FormEvent } from "react";
import { useActionState, useEffect, useState, useTransition } from "react";

import {
  deleteArticleAction,
  saveArticleAction,
  type ContentActionState,
} from "@/app/admin/content/actions";
import { BrowserMdx } from "@/content/browser-mdx";
import type { ArticleStatus } from "@/db/repository";

export type ArticleEditorRecord = {
  id?: string;
  categoryId: string;
  title: string;
  slug: string;
  mdx: string;
  status: ArticleStatus;
  isFaq: boolean;
  authorName: string;
};

type ArticleEditorProps = {
  article: ArticleEditorRecord;
  categories: Array<{ id: string; name: string }>;
};

type ArticlePreviewResult =
  | { status: "success"; compiled: string }
  | { status: "error"; message: string };

const initialActionState: ContentActionState = {
  status: "idle",
  message: "",
  revision: 0,
};

const initialPreview: ArticlePreviewResult = {
  status: "error",
  message: "Preparing the live preview…",
};

function describedBy(description: string, error: string | undefined) {
  return error ? `${description} ${description}-error` : description;
}

export function ArticleEditor({ article, categories }: ArticleEditorProps) {
  const [title, setTitle] = useState(article.title);
  const [categoryId, setCategoryId] = useState(article.categoryId);
  const [slug, setSlug] = useState(article.slug);
  const [authorName, setAuthorName] = useState(article.authorName);
  const [status, setStatus] = useState<ArticleStatus>(article.status);
  const [isFaq, setIsFaq] = useState(article.isFaq);
  const [source, setSource] = useState(article.mdx);
  const [preview, setPreview] = useState<ArticlePreviewResult>(initialPreview);
  const [previewPending, setPreviewPending] = useState(false);
  const [saveState, saveAction, saving] = useActionState(saveArticleAction, initialActionState);
  const [, startSaving] = useTransition();
  const [deleteState, deleteAction, deleting] = useActionState(
    deleteArticleAction,
    initialActionState,
  );

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setPreviewPending(true);
      void fetch("/admin/content/preview", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
        signal: controller.signal,
      })
        .then(async (response) => {
          const result = (await response.json()) as { compiled?: unknown; message?: unknown };
          if (response.ok && typeof result.compiled === "string") {
            setPreview({ status: "success", compiled: result.compiled });
            return;
          }
          setPreview({
            status: "error",
            message:
              typeof result.message === "string"
                ? result.message
                : "The preview could not be rendered.",
          });
        })
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            setPreview({ status: "error", message: "The preview could not be rendered." });
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setPreviewPending(false);
          }
        });
    }, 350);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [source]);

  function submitArticle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startSaving(() => {
      saveAction(formData);
    });
  }

  return (
    <div className="space-y-8">
      <form onSubmit={submitArticle} className="space-y-8">
        <input type="hidden" name="mode" value={article.id ? "update" : "create"} />
        {article.id ? <input type="hidden" name="id" value={article.id} /> : null}

        <section
          aria-labelledby="article-details-heading"
          className="rounded-lg border border-border bg-surface p-5 sm:p-6"
        >
          <div className="mb-6">
            <h2 id="article-details-heading" className="text-xl font-semibold tracking-[-0.02em]">
              Article details
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              Drafts stay private. Publishing makes the article available in its category on the
              next reload.
            </p>
          </div>
          <fieldset disabled={saving} className="grid gap-5 sm:grid-cols-2">
            <legend className="sr-only">Article metadata</legend>
            <div className="sm:col-span-2">
              <label htmlFor="article-title" className="block text-sm font-semibold">
                Title
              </label>
              <input
                id="article-title"
                name="title"
                required
                maxLength={160}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                aria-invalid={Boolean(saveState.fieldErrors?.title)}
                aria-describedby={describedBy(
                  "article-title-description",
                  saveState.fieldErrors?.title,
                )}
                className="mt-2 min-h-12 w-full rounded-md border border-border bg-background px-3 text-lg font-semibold"
              />
              <p id="article-title-description" className="mt-1.5 text-xs text-muted">
                Keep it specific and match the first heading in the MDX body.
              </p>
              {saveState.fieldErrors?.title ? (
                <p id="article-title-description-error" className="mt-1.5 text-sm text-danger">
                  {saveState.fieldErrors.title}
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor="article-category" className="block text-sm font-semibold">
                Category
              </label>
              <select
                id="article-category"
                name="categoryId"
                required
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
                aria-invalid={Boolean(saveState.fieldErrors?.categoryId)}
                aria-describedby={
                  saveState.fieldErrors?.categoryId ? "article-category-error" : undefined
                }
                className="mt-2 min-h-11 w-full rounded-md border border-border bg-background px-3"
              >
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              {saveState.fieldErrors?.categoryId ? (
                <p id="article-category-error" className="mt-1.5 text-sm text-danger">
                  {saveState.fieldErrors.categoryId}
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor="article-slug" className="block text-sm font-semibold">
                URL slug
              </label>
              <input
                id="article-slug"
                name="slug"
                required
                maxLength={120}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                aria-invalid={Boolean(saveState.fieldErrors?.slug)}
                aria-describedby={saveState.fieldErrors?.slug ? "article-slug-error" : undefined}
                className="mt-2 min-h-11 w-full rounded-md border border-border bg-background px-3 font-mono text-sm"
              />
              {saveState.fieldErrors?.slug ? (
                <p id="article-slug-error" className="mt-1.5 text-sm text-danger">
                  {saveState.fieldErrors.slug}
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor="article-author" className="block text-sm font-semibold">
                Author
              </label>
              <input
                id="article-author"
                name="authorName"
                required
                maxLength={100}
                value={authorName}
                onChange={(event) => setAuthorName(event.target.value)}
                aria-invalid={Boolean(saveState.fieldErrors?.authorName)}
                aria-describedby={
                  saveState.fieldErrors?.authorName ? "article-author-error" : undefined
                }
                className="mt-2 min-h-11 w-full rounded-md border border-border bg-background px-3"
              />
              {saveState.fieldErrors?.authorName ? (
                <p id="article-author-error" className="mt-1.5 text-sm text-danger">
                  {saveState.fieldErrors.authorName}
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor="article-status" className="block text-sm font-semibold">
                Publication state
              </label>
              <select
                id="article-status"
                name="status"
                value={status}
                onChange={(event) => setStatus(event.target.value as ArticleStatus)}
                className="mt-2 min-h-11 w-full rounded-md border border-border bg-background px-3"
              >
                <option value="draft">Draft</option>
                <option value="published">Published</option>
              </select>
            </div>
            <label className="flex min-h-11 items-center gap-3 rounded-md bg-surface-strong px-3 text-sm sm:col-span-2">
              <input
                type="checkbox"
                name="isFaq"
                checked={isFaq}
                onChange={(event) => setIsFaq(event.target.checked)}
                className="size-4"
              />
              This article is genuinely Q&amp;A-shaped and may emit FAQ structured data.
            </label>
          </fieldset>
        </section>

        <section aria-labelledby="article-body-heading">
          <div className="mb-4">
            <h2 id="article-body-heading" className="text-xl font-semibold tracking-[-0.02em]">
              MDX body and live preview
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
              Standard Markdown is supported. Imports, exports, JavaScript expressions, raw
              components, and unsafe link protocols are rejected before preview or save.
            </p>
          </div>
          <div className="grid overflow-hidden rounded-lg border border-border bg-surface lg:grid-cols-2">
            <div className="border-b border-border lg:border-b-0 lg:border-r">
              <label htmlFor="article-mdx" className="block px-4 py-3 text-sm font-semibold">
                Article MDX
              </label>
              <textarea
                id="article-mdx"
                name="mdx"
                required
                maxLength={100_000}
                rows={28}
                spellCheck={false}
                value={source}
                onChange={(event) => setSource(event.target.value)}
                aria-invalid={Boolean(saveState.fieldErrors?.mdx)}
                aria-describedby={saveState.fieldErrors?.mdx ? "article-mdx-error" : undefined}
                className="block min-h-[38rem] w-full resize-y border-0 border-t border-border bg-code-background p-4 font-mono text-sm leading-6 text-code-foreground outline-none"
              />
              {saveState.fieldErrors?.mdx ? (
                <p
                  id="article-mdx-error"
                  className="m-0 border-t border-danger bg-background px-4 py-3 text-sm text-danger"
                  role="alert"
                >
                  {saveState.fieldErrors.mdx}
                </p>
              ) : null}
            </div>
            <div className="min-w-0">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h3 className="m-0 text-sm font-semibold">Rendered answer</h3>
                <span className="text-xs text-muted" role="status" aria-live="polite">
                  {previewPending ? "Updating…" : preview.status === "success" ? "Up to date" : "Needs attention"}
                </span>
              </div>
              <div className="article-content article-preview p-5 sm:p-7">
                {preview.status === "success" ? (
                  <BrowserMdx compiled={preview.compiled} />
                ) : (
                  <p className="m-0 text-sm text-muted" role="alert">
                    {preview.message}
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>

        <div className="sticky bottom-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-elevated p-3 shadow-sm">
          <button
            type="submit"
            disabled={saving}
            className="min-h-11 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60"
          >
            {saving ? "Saving…" : article.id ? "Save article" : "Create article"}
          </button>
          <p
            className={`m-0 text-sm ${saveState.status === "error" ? "text-danger" : saveState.status === "success" ? "text-success" : "text-muted"}`}
            role={saveState.status === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {saveState.message || "Changes are stored immediately when saved."}
          </p>
        </div>
      </form>

      {article.id ? (
        <section aria-labelledby="delete-article-heading" className="rounded-lg border border-danger p-5">
          <h2 id="delete-article-heading" className="m-0 text-lg font-semibold text-danger">
            Delete article
          </h2>
          <p className="mb-4 mt-2 max-w-2xl text-sm leading-6 text-muted">
            This permanently removes the article and its feedback and view records. This action
            cannot be undone.
          </p>
          <form action={deleteAction} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="id" value={article.id} />
            <button
              type="submit"
              disabled={deleting}
              className="min-h-11 rounded-md bg-danger px-4 text-sm font-semibold text-danger-foreground disabled:cursor-wait disabled:opacity-60"
            >
              {deleting ? "Deleting…" : "Delete this article"}
            </button>
            {deleteState.message ? (
              <p className="m-0 text-sm text-danger" role="alert">
                {deleteState.message}
              </p>
            ) : null}
          </form>
        </section>
      ) : null}
    </div>
  );
}
