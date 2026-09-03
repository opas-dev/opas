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
import { requireMemberCapability } from "@/auth/admin";
import { demoIds } from "@/db/demo";
import { getThemeAuthoringRepository } from "@/db/theme-authoring-database";
import { themePresets } from "@/theme/presets";
import type { ThemeConfig } from "@/theme/schema";

export type ThemeActionState = {
  status: "idle" | "error" | "success";
  message: string;
  revision: number;
  themeId: string;
  themeVersion: number;
  activePreset: ThemePresetId | null;
  values: ThemeEditorValues;
  fieldErrors?: ThemeFieldErrors;
  code?: AuthoringPausedFailure["code"];
};

export async function updateThemeAction(
  previousState: ThemeActionState,
  formData: FormData,
): Promise<ThemeActionState> {
  const member = await requireMemberCapability("workspace:configure", demoIds.workspace);
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
    const result = await (await getThemeAuthoringRepository()).updateTheme({
      actor: {
        memberId: member.memberId,
        sessionId: member.sessionId,
        workspaceId: member.workspaceId,
      },
      expectedThemeVersion: request.data.expectedThemeVersion,
      theme: {
        id: request.data.id,
        workspaceId: demoIds.workspace,
        name,
        config,
      },
    });
    if (result.status === "conflict") {
      return {
        ...previousState,
        status: "error",
        message: "The theme changed in another tab. Reload before saving again.",
        revision,
        values,
        fieldErrors: undefined,
        code: undefined,
      };
    }
    if (result.status === "rejected") {
      return {
        ...previousState,
        status: "error",
        message:
          result.code === "ACTOR_FORBIDDEN"
            ? "Your access changed before the theme could be saved."
            : "The theme is no longer available. Reload and try again.",
        revision,
        values,
        fieldErrors: undefined,
        code: undefined,
      };
    }

    revalidatePath("/", "layout");

    return {
      status: "success",
      message:
        result.status === "unchanged"
          ? `${name} is already active.`
          : preset
            ? `${themePresetOptions[preset].name} is now active.`
            : `${name} was saved.`,
      revision,
      activePreset: preset,
      values,
      themeId: result.theme.id,
      themeVersion: result.theme.version,
    };
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
}
