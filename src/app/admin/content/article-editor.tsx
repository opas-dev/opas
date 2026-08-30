// ABOUTME: Edits article metadata and MDX with authenticated save, preview, and delete actions.
// ABOUTME: Debounces safe server compilation so authors see the rendered answer while typing.
"use client";

import type { FormEvent, KeyboardEvent } from "react";
import dynamic from "next/dynamic";
import {
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  deleteArticleAction,
  saveArticleAction,
  type ContentActionState,
} from "@/app/admin/content/actions";
import { articleAssetManifestNeedsReset } from "@/app/admin/content/article-asset-state";
import {
  inspectArticleVisualSource,
  joinArticleSource,
  replaceArticleTitleHeading,
} from "@/app/admin/content/article-source";
import type { StageArticleImage } from "@/app/admin/content/article-visual-editor";
import { isAssetHash, isAssetManifestId } from "@/assets/identity";
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

type AssetStageResult = {
  manifestId: string;
  hash: string;
  url: string;
};

const initialActionState: ContentActionState = {
  status: "idle",
  message: "",
  revision: 0,
};

const initialPreview: ArticlePreviewResult = {
  status: "error",
  message: "Preparing the live preview…",
};

const ArticleVisualEditor = dynamic(
  () =>
    import("@/app/admin/content/article-visual-editor").then(
      (module) => module.ArticleVisualEditor,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-[38rem] bg-background p-5 text-sm text-muted" role="status">
        Loading Visual editor…
      </div>
    ),
  },
);

function describedBy(description: string, error: string | undefined) {
  return error ? `${description} ${description}-error` : description;
}

async function assetStageResponse(response: Response): Promise<AssetStageResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("The image service returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(
      body &&
        typeof body === "object" &&
        "message" in body &&
        typeof body.message === "string"
        ? body.message
        : "The image could not be staged.",
    );
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("manifestId" in body) ||
    typeof body.manifestId !== "string" ||
    !isAssetManifestId(body.manifestId) ||
    !("hash" in body) ||
    typeof body.hash !== "string" ||
    !isAssetHash(body.hash) ||
    !("url" in body) ||
    body.url !== `/api/assets/${body.hash}`
  ) {
    throw new Error("The image service returned an invalid response.");
  }

  return { manifestId: body.manifestId, hash: body.hash, url: body.url };
}

export function ArticleEditor({ article, categories }: ArticleEditorProps) {
  const [title, setTitle] = useState(article.title);
  const [categoryId, setCategoryId] = useState(article.categoryId);
  const [slug, setSlug] = useState(article.slug);
  const [authorName, setAuthorName] = useState(article.authorName);
  const [status, setStatus] = useState<ArticleStatus>(article.status);
  const [isFaq, setIsFaq] = useState(article.isFaq);
  const [source, setSource] = useState(article.mdx);
  const [editorMode, setEditorMode] = useState<"visual" | "source">(() =>
    inspectArticleVisualSource(article.mdx, article.title).status === "ready"
      ? "visual"
      : "source",
  );
  const [preview, setPreview] = useState<ArticlePreviewResult>(initialPreview);
  const [previewPending, setPreviewPending] = useState(false);
  const [assetUploadPending, setAssetUploadPending] = useState(false);
  const activeRef = useRef(false);
  const assetManifestRef = useRef<string | undefined>(undefined);
  const assetUploadCountRef = useRef(0);
  const assetUploadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [saveState, saveAction, saving] = useActionState(saveArticleAction, initialActionState);
  const [, startSaving] = useTransition();
  const [deleteState, deleteAction, deleting] = useActionState(
    deleteArticleAction,
    initialActionState,
  );

  const discardAssetManifest = useCallback((manifestId: string) => {
    void fetch("/admin/content/assets", {
      method: "DELETE",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifestId }),
      keepalive: true,
    }).catch(() => {
      // Expiring manifests provide the final cleanup boundary if navigation ends the request.
    });
  }, []);

  useEffect(() => {
    activeRef.current = true;

    function handlePageHide(event: PageTransitionEvent) {
      if (event.persisted) {
        return;
      }
      activeRef.current = false;
      const manifestId = assetManifestRef.current;
      if (manifestId) {
        discardAssetManifest(manifestId);
      }
    }

    window.addEventListener("pagehide", handlePageHide);
    return () => {
      activeRef.current = false;
      window.removeEventListener("pagehide", handlePageHide);
      const manifestId = assetManifestRef.current;
      if (manifestId) {
        discardAssetManifest(manifestId);
      }
    };
  }, [discardAssetManifest]);

  useEffect(() => {
    if (articleAssetManifestNeedsReset(saveState)) {
      assetManifestRef.current = undefined;
    }
  }, [saveState]);

  const stageImage: NonNullable<StageArticleImage> = useCallback(async (file) => {
    assetUploadCountRef.current += 1;
    setAssetUploadPending(true);

    async function upload(suppliedManifestId?: string): Promise<string> {
      const formData = new FormData();
      formData.set("file", file);
      if (suppliedManifestId) {
        formData.set("manifestId", suppliedManifestId);
      }

      const response = await fetch("/admin/content/assets", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        body: formData,
      });

      if (response.status === 409 && suppliedManifestId) {
        if (assetManifestRef.current === suppliedManifestId) {
          assetManifestRef.current = undefined;
        }
        return upload();
      }

      const staged = await assetStageResponse(response);
      if (!activeRef.current) {
        discardAssetManifest(staged.manifestId);
        throw new Error("The image upload was cancelled when the editor closed.");
      }

      assetManifestRef.current = staged.manifestId;
      return staged.url;
    }

    const staged = assetUploadQueueRef.current.then(
      () => upload(assetManifestRef.current),
      () => upload(assetManifestRef.current),
    );
    assetUploadQueueRef.current = staged.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await staged;
    } finally {
      assetUploadCountRef.current -= 1;
      if (activeRef.current && assetUploadCountRef.current === 0) {
        setAssetUploadPending(false);
      }
    }
  }, [discardAssetManifest]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setPreviewPending(true);
      void fetch("/admin/content/preview", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, title }),
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
  }, [source, title]);

  function submitArticle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (assetUploadPending) {
      return;
    }
    const formData = new FormData(event.currentTarget);
    const manifestId = assetManifestRef.current;
    if (manifestId) {
      formData.set("assetManifestId", manifestId);
    }

    startSaving(() => {
      saveAction(formData);
    });
  }

  const visualSource = inspectArticleVisualSource(source, title);

  function handleEditorTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    let nextMode: "visual" | "source" | null = null;
    if (event.key === "Home") {
      nextMode = visualSource.status === "ready" ? "visual" : "source";
    } else if (event.key === "End") {
      nextMode = "source";
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      nextMode =
        editorMode === "source" && visualSource.status === "ready"
          ? "visual"
          : "source";
    }

    if (!nextMode) {
      return;
    }

    event.preventDefault();
    setEditorMode(nextMode);
    event.currentTarget.ownerDocument
      .getElementById(`article-editor-${nextMode}-tab`)
      ?.focus();
  }

  function updateTitle(nextTitle: string) {
    setSource((currentSource) => replaceArticleTitleHeading(currentSource, nextTitle));
    setTitle(nextTitle);
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
                onChange={(event) => updateTitle(event.target.value)}
                aria-invalid={Boolean(saveState.fieldErrors?.title)}
                aria-describedby={describedBy(
                  "article-title-description",
                  saveState.fieldErrors?.title,
                )}
                className="mt-2 min-h-12 w-full rounded-md border border-border bg-background px-3 text-lg font-semibold"
              />
              <p id="article-title-description" className="mt-1.5 text-xs text-muted">
                This field owns the article heading in both editor modes.
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
              Article body and live preview
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
              Use Visual mode for routine authoring or Source mode for portable Markdown. Imports,
              expressions, raw components, and unsafe URLs are rejected before preview or save.
            </p>
          </div>
          <div className="grid overflow-hidden rounded-lg border border-border bg-surface lg:grid-cols-2">
            <div className="min-w-0 border-b border-border lg:border-b-0 lg:border-r">
              <input type="hidden" name="mdx" value={source} />
              <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
                <span className="text-sm font-semibold">Article editor</span>
                <div
                  className="inline-flex rounded-md bg-surface-strong p-1"
                  role="tablist"
                  aria-label="Article editor mode"
                >
                  <button
                    id="article-editor-visual-tab"
                    type="button"
                    role="tab"
                    aria-selected={editorMode === "visual"}
                    aria-controls="article-editor-visual-panel"
                    aria-describedby={
                      visualSource.status === "unsupported" ? "article-visual-mode-issue" : undefined
                    }
                    disabled={visualSource.status === "unsupported"}
                    tabIndex={editorMode === "visual" ? 0 : -1}
                    onClick={() => setEditorMode("visual")}
                    onKeyDown={handleEditorTabKeyDown}
                    className="min-h-9 rounded-sm px-3 text-sm font-semibold aria-selected:bg-background aria-selected:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Visual
                  </button>
                  <button
                    id="article-editor-source-tab"
                    type="button"
                    role="tab"
                    aria-selected={editorMode === "source"}
                    aria-controls="article-editor-source-panel"
                    tabIndex={editorMode === "source" ? 0 : -1}
                    onClick={() => setEditorMode("source")}
                    onKeyDown={handleEditorTabKeyDown}
                    className="min-h-9 rounded-sm px-3 text-sm font-semibold aria-selected:bg-background aria-selected:text-primary"
                  >
                    Source
                  </button>
                </div>
              </div>
              {editorMode === "visual" && visualSource.status === "ready" ? (
                <div
                  id="article-editor-visual-panel"
                  role="tabpanel"
                  aria-labelledby="article-editor-visual-tab"
                >
                  <ArticleVisualEditor
                    markdown={visualSource.body}
                    onChange={(body) => setSource(joinArticleSource(title, body))}
                    stageImage={stageImage}
                  />
                </div>
              ) : (
                <div
                  id="article-editor-source-panel"
                  role="tabpanel"
                  aria-labelledby="article-editor-source-tab"
                >
                  <label htmlFor="article-mdx" className="sr-only">
                    Article Markdown source
                  </label>
                  {visualSource.status === "unsupported" ? (
                    <p
                      id="article-visual-mode-issue"
                      className="m-0 border-b border-warning bg-surface-strong px-4 py-3 text-sm text-foreground"
                      role="status"
                    >
                      {visualSource.message} Edit the source to continue visually.
                    </p>
                  ) : null}
                  <textarea
                    id="article-mdx"
                    required
                    maxLength={100_000}
                    rows={28}
                    spellCheck={false}
                    value={source}
                    onChange={(event) => setSource(event.target.value)}
                    aria-invalid={Boolean(saveState.fieldErrors?.mdx)}
                    aria-describedby={
                      saveState.fieldErrors?.mdx ? "article-mdx-error" : undefined
                    }
                    className="block min-h-[38rem] w-full resize-y border-0 bg-code-background p-4 font-mono text-sm leading-6 text-code-foreground outline-none"
                  />
                </div>
              )}
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
                  <BrowserMdx authenticatedAssets compiled={preview.compiled} />
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
            disabled={saving || assetUploadPending}
            className="min-h-11 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60"
          >
            {assetUploadPending
              ? "Uploading image…"
              : saving
                ? "Saving…"
                : article.id
                  ? "Save article"
                  : "Create article"}
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
