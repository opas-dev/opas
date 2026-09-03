// ABOUTME: Edits one content category with accessible save and guarded delete feedback.
// ABOUTME: Keeps each category interaction isolated so concurrent forms retain their state.
"use client";

import type { FormEvent } from "react";
import { useActionState, useState, useTransition } from "react";

import {
  deleteCategoryAction,
  saveCategoryAction,
  type ContentActionState,
} from "@/app/admin/content/actions";
import type { AuthoringCategory } from "@/db/category-authoring";

type CategoryEditorProps = {
  category?: AuthoringCategory;
  articleCount?: number;
};

function statusClasses(status: ContentActionState["status"]) {
  if (status === "error") {
    return "bg-danger text-danger-foreground";
  }
  if (status === "success") {
    return "bg-success text-success-foreground";
  }
  return "bg-surface-strong text-muted";
}

export function CategoryEditor({ category, articleCount = 0 }: CategoryEditorProps) {
  const initialState: ContentActionState = {
    status: "idle",
    message: "",
    revision: 0,
    recordVersion: category?.version,
  };
  const [saveState, saveAction, saving] = useActionState(saveCategoryAction, initialState);
  const [, startSaving] = useTransition();
  const [deleteState, deleteAction, deleting] = useActionState(
    deleteCategoryAction,
    initialState,
  );
  const [name, setName] = useState(category?.name ?? "");
  const [slug, setSlug] = useState(category?.slug ?? "");
  const [description, setDescription] = useState(category?.description ?? "");
  const [position, setPosition] = useState(String(category?.position ?? 0));
  const fieldPrefix = category?.id ?? "new-category";

  function submitCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startSaving(() => {
      saveAction(formData);
    });
  }

  return (
    <details
      className="group rounded-md border border-border bg-surface"
      open={!category ? true : undefined}
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 font-semibold marker:hidden">
        <span>{category?.name ?? "Add a category"}</span>
        <span className="text-xs font-medium text-muted">
          {category
            ? `${articleCount} ${articleCount === 1 ? "article" : "articles"}`
            : "New section"}
        </span>
      </summary>
      <div className="border-t border-border p-4">
        <form onSubmit={submitCategory} className="space-y-4">
          <input type="hidden" name="mode" value={category ? "update" : "create"} />
          {category ? <input type="hidden" name="id" value={category.id} /> : null}
          {category ? (
            <input
              type="hidden"
              name="expectedCategoryVersion"
              value={saveState.recordVersion ?? category.version}
            />
          ) : null}
          <fieldset disabled={saving} className="grid gap-4 sm:grid-cols-2">
            <legend className="sr-only">
              {category ? `Edit ${category.name}` : "Create a category"}
            </legend>
            <div>
              <label htmlFor={`${fieldPrefix}-name`} className="block text-sm font-semibold">
                Name
              </label>
              <input
                id={`${fieldPrefix}-name`}
                name="name"
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-invalid={Boolean(saveState.fieldErrors?.name)}
                aria-describedby={
                  saveState.fieldErrors?.name ? `${fieldPrefix}-name-error` : undefined
                }
                className="mt-2 min-h-11 w-full rounded-md border border-border bg-background px-3"
              />
              {saveState.fieldErrors?.name ? (
                <p id={`${fieldPrefix}-name-error`} className="mt-1 text-sm text-danger">
                  {saveState.fieldErrors.name}
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor={`${fieldPrefix}-slug`} className="block text-sm font-semibold">
                URL slug
              </label>
              <input
                id={`${fieldPrefix}-slug`}
                name="slug"
                required
                maxLength={120}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                aria-invalid={Boolean(saveState.fieldErrors?.slug)}
                aria-describedby={
                  saveState.fieldErrors?.slug ? `${fieldPrefix}-slug-error` : undefined
                }
                className="mt-2 min-h-11 w-full rounded-md border border-border bg-background px-3 font-mono text-sm"
              />
              {saveState.fieldErrors?.slug ? (
                <p id={`${fieldPrefix}-slug-error`} className="mt-1 text-sm text-danger">
                  {saveState.fieldErrors.slug}
                </p>
              ) : null}
            </div>
            <div>
              <label
                htmlFor={`${fieldPrefix}-description`}
                className="block text-sm font-semibold"
              >
                Description
              </label>
              <textarea
                id={`${fieldPrefix}-description`}
                name="description"
                rows={3}
                maxLength={300}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                aria-invalid={Boolean(saveState.fieldErrors?.description)}
                aria-describedby={
                  saveState.fieldErrors?.description
                    ? `${fieldPrefix}-description-error`
                    : undefined
                }
                className="mt-2 w-full resize-y rounded-md border border-border bg-background p-3"
              />
              {saveState.fieldErrors?.description ? (
                <p id={`${fieldPrefix}-description-error`} className="mt-1 text-sm text-danger">
                  {saveState.fieldErrors.description}
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor={`${fieldPrefix}-position`} className="block text-sm font-semibold">
                Position
              </label>
              <input
                id={`${fieldPrefix}-position`}
                name="position"
                type="number"
                required
                min={0}
                max={10_000}
                step={1}
                value={position}
                onChange={(event) => setPosition(event.target.value)}
                aria-invalid={Boolean(saveState.fieldErrors?.position)}
                aria-describedby={
                  saveState.fieldErrors?.position ? `${fieldPrefix}-position-error` : undefined
                }
                className="mt-2 min-h-11 w-full rounded-md border border-border bg-background px-3"
              />
              {saveState.fieldErrors?.position ? (
                <p id={`${fieldPrefix}-position-error`} className="mt-1 text-sm text-danger">
                  {saveState.fieldErrors.position}
                </p>
              ) : null}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60"
            >
              {saving ? "Saving…" : category ? "Save category" : "Create category"}
            </button>
            {saveState.status !== "idle" ? (
              <p
                className={`m-0 rounded-sm px-3 py-2 text-sm ${statusClasses(saveState.status)}`}
                role={saveState.status === "error" ? "alert" : "status"}
              >
                {saveState.message}
              </p>
            ) : null}
          </div>
        </form>

        {category ? (
          <details className="mt-5 border-t border-border pt-4">
            <summary className="cursor-pointer text-sm font-semibold text-danger">
              Delete category
            </summary>
            <p className="mb-3 mt-2 max-w-xl text-sm leading-6 text-muted">
              Empty categories can be deleted. OPAS blocks deletion while articles still belong to
              this category.
            </p>
            <form action={deleteAction} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="id" value={category.id} />
              <input
                type="hidden"
                name="expectedCategoryVersion"
                value={saveState.recordVersion ?? category.version}
              />
              <button
                type="submit"
                disabled={deleting}
                className="min-h-10 rounded-md bg-danger px-3 text-sm font-semibold text-danger-foreground disabled:cursor-wait disabled:opacity-60"
              >
                {deleting ? "Deleting…" : `Delete ${category.name}`}
              </button>
              {deleteState.status !== "idle" ? (
                <p
                  className={`m-0 rounded-sm px-3 py-2 text-sm ${statusClasses(deleteState.status)}`}
                  role={deleteState.status === "error" ? "alert" : "status"}
                >
                  {deleteState.message}
                </p>
              ) : null}
            </form>
          </details>
        ) : null}
      </div>
    </details>
  );
}
