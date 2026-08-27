// ABOUTME: Validates preset and JSON submissions from the admin theme editor.
// ABOUTME: Converts untrusted form data into the fixed runtime theme contract.
import { z } from "zod";

import {
  themePresetIds,
  themePresetOptions,
  type ThemePresetId,
} from "@/app/admin/theme/options";
import { themePresets } from "@/theme/presets";
import { themeSchema, type ThemeConfig } from "@/theme/schema";

const presetRequestSchema = z.strictObject({
  intent: z.literal("preset"),
  preset: z.enum(themePresetIds),
});

const jsonRequestSchema = z.strictObject({
  intent: z.literal("json"),
  name: z
    .string()
    .trim()
    .min(1, "Enter a theme name")
    .max(80, "Theme names must be 80 characters or fewer"),
  config: z
    .string()
    .min(1, "Enter the theme JSON")
    .max(100_000, "Theme JSON must be 100 KB or smaller"),
});

const themeRequestSchema = z.discriminatedUnion("intent", [
  presetRequestSchema,
  jsonRequestSchema,
]);

export type ThemeEditorValues = {
  name: string;
  configJson: string;
};

export type ThemeFieldErrors = Partial<
  Record<"form" | "preset" | "name" | "config", string>
>;

export type ThemeRequest =
  | {
      kind: "preset";
      preset: ThemePresetId;
    }
  | {
      kind: "json";
      name: string;
      config: ThemeConfig;
    };

export type ThemeRequestResult =
  | { success: true; data: ThemeRequest }
  | {
      success: false;
      fieldErrors: ThemeFieldErrors;
      values?: ThemeEditorValues;
    };

function editorValues(input: Record<string, FormDataEntryValue>): ThemeEditorValues {
  return {
    name: typeof input.name === "string" ? input.name : "",
    configJson: typeof input.config === "string" ? input.config : "",
  };
}

function requestErrors(error: z.ZodError): ThemeFieldErrors {
  const fieldErrors: ThemeFieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path[0];
    if (
      (field === "preset" || field === "name" || field === "config") &&
      !fieldErrors[field]
    ) {
      fieldErrors[field] = issue.message;
    }
  }

  if (error.issues.some((issue) => issue.path.length === 0)) {
    fieldErrors.form = "The theme request contained unexpected fields.";
  }

  if (!fieldErrors.preset && !fieldErrors.name && !fieldErrors.config && !fieldErrors.form) {
    fieldErrors.form = "Choose a preset or submit a valid JSON theme.";
  }

  return fieldErrors;
}

function themeError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return "Theme JSON does not match the required token schema.";
  }

  const location = issue.path.map(String).join(".");
  return location ? `${location}: ${issue.message}` : issue.message;
}

export function findThemePreset(name: string, config: ThemeConfig): ThemePresetId | null {
  const normalizedConfig = JSON.stringify(themeSchema.parse(config));

  return (
    themePresetIds.find(
      (id) =>
        themePresetOptions[id].name === name &&
        JSON.stringify(themePresets[id]) === normalizedConfig,
    ) ?? null
  );
}

export function parseThemeRequest(formData: FormData): ThemeRequestResult {
  const input = Object.fromEntries(
    [...formData.entries()].filter(([name]) => !name.startsWith("$ACTION_")),
  );
  const request = themeRequestSchema.safeParse(input);

  if (!request.success) {
    return {
      success: false,
      fieldErrors: requestErrors(request.error),
      values: input.intent === "json" ? editorValues(input) : undefined,
    };
  }

  if (request.data.intent === "preset") {
    return {
      success: true,
      data: {
        kind: "preset",
        preset: request.data.preset,
      },
    };
  }

  let config: unknown;
  try {
    config = JSON.parse(request.data.config);
  } catch {
    return {
      success: false,
      fieldErrors: { config: "Enter valid JSON before saving the theme." },
      values: editorValues(input),
    };
  }

  const parsedTheme = themeSchema.safeParse(config);
  if (!parsedTheme.success) {
    return {
      success: false,
      fieldErrors: { config: themeError(parsedTheme.error) },
      values: editorValues(input),
    };
  }

  return {
    success: true,
    data: {
      kind: "json",
      name: request.data.name,
      config: parsedTheme.data,
    },
  };
}
