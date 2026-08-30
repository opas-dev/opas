// ABOUTME: Renders accessible article link, image, and permanent-deletion authoring controls.
// ABOUTME: Keeps field labels, validation messages, focus targets, and destructive confirmation explicit.

import type { FormEvent } from "react";

const fieldClassName =
  "mt-2 min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground";
const secondaryButtonClassName =
  "min-h-11 rounded-md border border-border bg-background px-4 text-sm font-semibold text-foreground";

type ArticleLinkFormProps = {
  url: string;
  title: string;
  text: string;
  showTextField: boolean;
  urlIssue: string | null;
  onUrlChange: (value: string) => void;
  onTitleChange: (value: string) => void;
  onTextChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

export function ArticleLinkForm({
  url,
  title,
  text,
  showTextField,
  urlIssue,
  onUrlChange,
  onTitleChange,
  onTextChange,
  onSubmit,
  onCancel,
}: ArticleLinkFormProps) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="opas-editor-link-url" className="block text-sm font-semibold">
          Link URL
        </label>
        <input
          id="opas-editor-link-url"
          name="url"
          required
          autoFocus
          inputMode="url"
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          aria-invalid={Boolean(urlIssue)}
          aria-describedby={urlIssue ? "opas-editor-link-url-error" : undefined}
          className={fieldClassName}
        />
        {urlIssue ? (
          <p id="opas-editor-link-url-error" className="mt-2 text-sm text-danger" role="alert">
            {urlIssue}
          </p>
        ) : null}
      </div>
      {showTextField ? (
        <div>
          <label htmlFor="opas-editor-link-text" className="block text-sm font-semibold">
            Link text
          </label>
          <input
            id="opas-editor-link-text"
            name="text"
            value={text}
            onChange={(event) => onTextChange(event.target.value)}
            className={fieldClassName}
          />
          <p className="mt-1.5 text-xs text-muted">
            Leave blank to use the URL as the visible text.
          </p>
        </div>
      ) : null}
      <div>
        <label htmlFor="opas-editor-link-title" className="block text-sm font-semibold">
          Link title <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id="opas-editor-link-title"
          name="title"
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          className={fieldClassName}
        />
      </div>
      <div className="flex flex-wrap justify-end gap-3">
        <button type="button" onClick={onCancel} className={secondaryButtonClassName}>
          Cancel
        </button>
        <button
          type="submit"
          className="min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground"
        >
          Save link
        </button>
      </div>
    </form>
  );
}

type ArticleImageFormProps = {
  source: string;
  altText: string;
  title: string;
  decorative: boolean;
  canUpload: boolean;
  selectedFileName: string | null;
  busy: boolean;
  issue: string | null;
  focusAltText: boolean;
  onFileChange: (file: File | null) => void;
  onSourceChange: (value: string) => void;
  onAltTextChange: (value: string) => void;
  onTitleChange: (value: string) => void;
  onDecorativeChange: (value: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

export function ArticleImageForm({
  source,
  altText,
  title,
  decorative,
  canUpload,
  selectedFileName,
  busy,
  issue,
  focusAltText,
  onFileChange,
  onSourceChange,
  onAltTextChange,
  onTitleChange,
  onDecorativeChange,
  onSubmit,
  onCancel,
}: ArticleImageFormProps) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {canUpload ? (
        <div>
          <label htmlFor="opas-editor-image-file" className="block text-sm font-semibold">
            Upload image
          </label>
          <input
            id="opas-editor-image-file"
            name="file"
            type="file"
            accept="image/*"
            autoFocus={!focusAltText}
            disabled={busy}
            onChange={(event) => onFileChange(event.target.files?.item(0) ?? null)}
            className={fieldClassName}
          />
          {selectedFileName ? (
            <p className="mt-1.5 text-xs text-muted" role="status">
              Ready to upload: {selectedFileName}
            </p>
          ) : null}
        </div>
      ) : null}
      <div>
        <label htmlFor="opas-editor-image-source" className="block text-sm font-semibold">
          {canUpload ? "Or use an image URL" : "Image URL"}
        </label>
        <input
          id="opas-editor-image-source"
          name="src"
          required={!selectedFileName}
          inputMode="url"
          disabled={busy}
          value={source}
          onChange={(event) => onSourceChange(event.target.value)}
          className={fieldClassName}
        />
      </div>
      <div>
        <label htmlFor="opas-editor-image-alt" className="block text-sm font-semibold">
          Alternative text
        </label>
        <input
          id="opas-editor-image-alt"
          name="altText"
          required={!decorative}
          autoFocus={focusAltText}
          disabled={busy || decorative}
          value={decorative ? "" : altText}
          onChange={(event) => onAltTextChange(event.target.value)}
          aria-describedby="opas-editor-image-alt-help"
          className={fieldClassName}
        />
        <p id="opas-editor-image-alt-help" className="mt-1.5 text-xs text-muted">
          Describe the information the image adds for someone who cannot see it.
        </p>
      </div>
      <label className="flex min-h-11 items-center gap-3 rounded-md bg-surface-strong px-3 text-sm">
        <input
          id="opas-editor-image-decorative"
          name="decorative"
          type="checkbox"
          checked={decorative}
          disabled={busy}
          onChange={(event) => onDecorativeChange(event.target.checked)}
          className="size-5"
        />
        This image is decorative and should be ignored by screen readers.
      </label>
      <div>
        <label htmlFor="opas-editor-image-title" className="block text-sm font-semibold">
          Image title <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id="opas-editor-image-title"
          name="title"
          disabled={busy}
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          className={fieldClassName}
        />
      </div>
      {issue ? (
        <p className="m-0 text-sm text-danger" role="alert">
          {issue}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className={secondaryButtonClassName}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? "Uploading…" : "Save image"}
        </button>
      </div>
    </form>
  );
}

type ArticleDeletionConfirmationProps = {
  articleId: string;
  confirmationOpen: boolean;
  deleting: boolean;
  message: string;
  action: (formData: FormData) => void;
  onRequestConfirmation: () => void;
  onCancel: () => void;
};

export function ArticleDeletionConfirmation({
  articleId,
  confirmationOpen,
  deleting,
  message,
  action,
  onRequestConfirmation,
  onCancel,
}: ArticleDeletionConfirmationProps) {
  if (!confirmationOpen) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onRequestConfirmation}
          className="min-h-11 rounded-md bg-danger px-4 text-sm font-semibold text-danger-foreground"
        >
          Delete this article
        </button>
        {message ? (
          <p className="m-0 text-sm text-danger" role="alert">
            {message}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="rounded-md border border-danger bg-surface-strong p-4"
      role="group"
      aria-labelledby="delete-article-confirmation"
    >
      <p id="delete-article-confirmation" className="m-0 text-sm font-semibold text-danger">
        Permanently delete this article and its feedback and view records?
      </p>
      <form action={action} className="mt-4 flex flex-wrap items-center gap-3">
        <input type="hidden" name="id" value={articleId} />
        <button
          type="submit"
          disabled={deleting}
          className="min-h-11 rounded-md bg-danger px-4 text-sm font-semibold text-danger-foreground disabled:cursor-wait disabled:opacity-60"
        >
          {deleting ? "Deleting…" : "Yes, delete permanently"}
        </button>
        <button
          type="button"
          disabled={deleting}
          onClick={onCancel}
          className={secondaryButtonClassName}
        >
          Cancel
        </button>
        {message ? (
          <p className="m-0 text-sm text-danger" role="alert">
            {message}
          </p>
        ) : null}
      </form>
    </div>
  );
}
