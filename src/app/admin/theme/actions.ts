// ABOUTME: Applies authenticated theme changes from the admin editor.
// ABOUTME: Revalidates the application shell so stored tokens appear without a rebuild.
"use server";

import { revalidatePath } from "next/cache";

import { themePresetOptions, type ThemePresetId } from "@/app/admin/theme/options";
import {
  parseThemeRequest,
  type ThemeEditorValues,
  type ThemeFieldErrors,
} from "@/app/admin/theme/validation";
import {
  getAuthoringPausedFailure,
  type AuthoringPausedFailure,
} from "@/authoring/failures";
import { requireAdmin } from "@/auth/admin";
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";
import { themePresets } from "@/theme/presets";
import type { ThemeConfig } from "@/theme/schema";

export type ThemeActionState = {
  status: "idle" | "error" | "success";
  message: string;
  revision: number;
  activePreset: ThemePresetId | null;
  values: ThemeEditorValues;
  fieldErrors?: ThemeFieldErrors;
  code?: AuthoringPausedFailure["code"];
};

export async function updateThemeAction(
  previousState: ThemeActionState,
  formData: FormData,
): Promise<ThemeActionState> {
  await requireAdmin();
  const revision = previousState.revision + 1;
  const request = parseThemeRequest(formData);

  if (!request.success) {
    return {
      ...previousState,
      status: "error",
      message: "Review the highlighted theme fields.",
      revision,
      values: request.values ?? previousState.values,
      fieldErrors: request.fieldErrors,
      code: undefined,
    };
  }

  let preset: ThemePresetId | null;
  let name: string;
  let config: ThemeConfig;

  if (request.data.kind === "preset") {
    preset = request.data.preset;
    name = themePresetOptions[preset].name;
    config = themePresets[preset];
  } else {
    preset = null;
    name = request.data.name;
    config = request.data.config;
  }
  const values = {
    name,
    configJson: JSON.stringify(config, null, 2),
  };

  try {
    await (await getRepository()).updateTheme({
      workspaceId: demoIds.workspace,
      name,
      config,
    });
  } catch (error) {
    const paused = getAuthoringPausedFailure(error);
    if (paused) {
      return {
        ...previousState,
        ...paused,
        status: "error",
        revision,
        values,
        fieldErrors: undefined,
      };
    }
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    console.error("Theme persistence failed.", {
      type: error instanceof Error ? error.name : "UnknownError",
      code,
    });

    return {
      ...previousState,
      status: "error",
      message: "The theme could not be saved. Try again.",
      revision,
      values,
      fieldErrors: undefined,
      code: undefined,
    };
  }

  revalidatePath("/", "layout");

  return {
    status: "success",
    message: preset
      ? `${themePresetOptions[preset].name} is now active.`
      : `${name} was saved.`,
    revision,
    activePreset: preset,
    values,
  };
}
