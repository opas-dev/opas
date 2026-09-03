// ABOUTME: Renders the interactive preset selector and validated JSON theme editor.
// ABOUTME: Announces pending, error, and success states for accessible theme changes.
"use client";

import { useActionState } from "react";

import {
  updateThemeAction,
  type ThemeActionState,
} from "@/app/admin/theme/actions";
import type { ThemePresetId } from "@/app/admin/theme/options";

export type ThemePresetPreview = {
  id: ThemePresetId;
  name: string;
  description: string;
  colors: {
    background: string;
    surface: string;
    primary: string;
    accent: string;
  };
};

type ThemeEditorProps = {
  initialThemeId: string;
  initialThemeVersion: number;
  initialName: string;
  initialConfigJson: string;
  initialActivePreset: ThemePresetId | null;
  presets: ThemePresetPreview[];
};

function fieldDescriptionId(field: "name" | "config", hasError: boolean) {
  return hasError ? `${field}-description ${field}-error` : `${field}-description`;
}

export function ThemeEditor({
  initialThemeId,
  initialThemeVersion,
  initialName,
  initialConfigJson,
  initialActivePreset,
  presets,
}: ThemeEditorProps) {
  const initialState: ThemeActionState = {
    status: "idle",
    message: "",
    revision: 0,
    themeId: initialThemeId,
    themeVersion: initialThemeVersion,
    activePreset: initialActivePreset,
    values: {
      name: initialName,
      configJson: initialConfigJson,
    },
  };
  const [state, formAction, pending] = useActionState(updateThemeAction, initialState);
  const nameError = state.fieldErrors?.name;
  const configError = state.fieldErrors?.config;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start">
      <div className="space-y-8">
        <section aria-labelledby="preset-heading">
          <div className="mb-4 max-w-2xl">
            <h2 id="preset-heading" className="text-xl font-semibold tracking-[-0.02em]">
              Choose a preset
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              Apply a complete, accessible token set. The public help center changes on its next
              reload.
            </p>
          </div>

          <form action={formAction}>
            <input type="hidden" name="intent" value="preset" />
            <input type="hidden" name="id" value={state.themeId} />
            <input
              type="hidden"
              name="expectedThemeVersion"
              value={state.themeVersion}
            />
            <fieldset disabled={pending} className="grid gap-3 sm:grid-cols-2">
              <legend className="sr-only">Available theme presets</legend>
              {presets.map((preset) => {
                const active = state.activePreset === preset.id;

                return (
                  <button
                    key={preset.id}
                    type="submit"
                    name="preset"
                    value={preset.id}
                    aria-pressed={active}
                    className={`min-h-36 rounded-md border p-4 text-left transition-colors duration-200 disabled:cursor-wait disabled:opacity-60 ${
                      active
                        ? "border-primary bg-secondary"
                        : "border-border bg-surface hover:border-border-strong hover:bg-surface-strong"
                    }`}
                  >
                    <span className="mb-4 flex h-8 overflow-hidden rounded-sm border border-border">
                      <span
                        className="flex-1"
                        style={{ backgroundColor: preset.colors.background }}
                        aria-hidden="true"
                      />
                      <span
                        className="flex-1"
                        style={{ backgroundColor: preset.colors.surface }}
                        aria-hidden="true"
                      />
                      <span
                        className="flex-1"
                        style={{ backgroundColor: preset.colors.primary }}
                        aria-hidden="true"
                      />
                      <span
                        className="flex-1"
                        style={{ backgroundColor: preset.colors.accent }}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="flex items-center justify-between gap-3">
                      <span className="font-semibold">{preset.name}</span>
                      {active ? (
                        <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                          Current
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-1.5 block text-sm leading-5 text-muted">
                      {preset.description}
                    </span>
                  </button>
                );
              })}
            </fieldset>
            {state.fieldErrors?.preset ? (
              <p className="mt-3 text-sm font-medium text-danger" role="alert">
                {state.fieldErrors.preset}
              </p>
            ) : null}
          </form>
        </section>

        <aside className="rounded-md bg-surface-strong p-4 text-sm leading-6 text-muted">
          <p className="m-0 font-semibold text-foreground">Runtime token boundary</p>
          <p className="mb-0 mt-1">
            Colors, font stacks, radii, and the logo URL can change here without rebuilding. New
            Tailwind utilities still require a build.
          </p>
        </aside>
      </div>

      <section aria-labelledby="json-heading" className="rounded-lg bg-surface p-5 sm:p-6">
        <div className="max-w-2xl">
          <h2 id="json-heading" className="text-xl font-semibold tracking-[-0.02em]">
            Edit theme JSON
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Fine-tune the fixed token set. Values are parsed and validated before anything is
            stored.
          </p>
        </div>

        <form action={formAction} className="mt-6 space-y-5">
          <input type="hidden" name="intent" value="json" />
          <input type="hidden" name="id" value={state.themeId} />
          <input
            type="hidden"
            name="expectedThemeVersion"
            value={state.themeVersion}
          />
          <fieldset disabled={pending} className="space-y-5">
            <legend className="sr-only">Theme JSON settings</legend>
            <div>
              <label htmlFor="name" className="block text-sm font-semibold">
                Theme name
              </label>
              <input
                key={`name-${state.revision}`}
                id="name"
                name="name"
                type="text"
                required
                maxLength={80}
                defaultValue={state.values.name}
                aria-invalid={Boolean(nameError)}
                aria-describedby={fieldDescriptionId("name", Boolean(nameError))}
                className="mt-2 min-h-11 w-full rounded-md border border-border bg-background px-3 text-foreground transition-colors duration-200 placeholder:text-muted hover:border-border-strong disabled:cursor-wait disabled:opacity-60 aria-invalid:border-danger"
              />
              <p id="name-description" className="mt-1.5 text-xs leading-5 text-muted">
                Shown to administrators; up to 80 characters.
              </p>
              {nameError ? (
                <p id="name-error" className="mt-1.5 text-sm font-medium text-danger">
                  {nameError}
                </p>
              ) : null}
            </div>

            <div>
              <label htmlFor="config" className="block text-sm font-semibold">
                Token configuration
              </label>
              <textarea
                key={`config-${state.revision}`}
                id="config"
                name="config"
                required
                rows={30}
                defaultValue={state.values.configJson}
                spellCheck={false}
                aria-invalid={Boolean(configError)}
                aria-describedby={fieldDescriptionId("config", Boolean(configError))}
                className="mt-2 w-full resize-y rounded-md border border-border bg-code-background p-3 font-mono text-sm leading-6 text-code-foreground transition-colors duration-200 hover:border-border-strong disabled:cursor-wait disabled:opacity-60 aria-invalid:border-danger"
              />
              <p id="config-description" className="mt-1.5 text-xs leading-5 text-muted">
                Strict JSON only. Unknown or missing tokens are rejected.
              </p>
              {configError ? (
                <p id="config-error" className="mt-1.5 text-sm font-medium text-danger">
                  {configError}
                </p>
              ) : null}
            </div>

            <button
              type="submit"
              className="min-h-11 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors duration-200 hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
            >
              {pending ? "Saving…" : "Save JSON theme"}
            </button>
          </fieldset>
        </form>
      </section>

      <div
        className={`lg:col-span-2 rounded-md px-4 py-3 text-sm font-medium ${
          state.status === "error"
            ? "bg-danger text-danger-foreground"
            : state.status === "success"
              ? "bg-success text-success-foreground"
              : "bg-surface-strong text-muted"
        }`}
        role={state.status === "error" ? "alert" : "status"}
        aria-live="polite"
        aria-atomic="true"
      >
        {pending
          ? "Saving the theme…"
          : state.message || "Theme changes are saved directly to this workspace."}
        {state.fieldErrors?.form ? ` ${state.fieldErrors.form}` : ""}
      </div>
    </div>
  );
}
