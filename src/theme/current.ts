// ABOUTME: Loads and validates the active workspace theme for each incoming request.
// ABOUTME: Falls back to the bundled OPAS preset when stored theme JSON is absent or invalid.
import "server-only";

import { connection } from "next/server";
import { cache } from "react";

import { demoIds } from "@/db/demo";
import { getRepository } from "@/db";
import { themePresets } from "@/theme/presets";
import { themeSchema, type ThemeConfig } from "@/theme/schema";

export type CurrentTheme = {
  name: string;
  config: ThemeConfig;
  updatedAt: Date | null;
};

export const getCurrentTheme = cache(async (): Promise<CurrentTheme> => {
  await connection();

  const storedTheme = await (await getRepository()).getTheme(demoIds.workspace);
  const parsedTheme = themeSchema.safeParse(storedTheme?.config);

  if (!storedTheme || !parsedTheme.success) {
    return {
      name: "OPAS Default",
      config: themePresets.opas,
      updatedAt: null,
    };
  }

  return {
    name: storedTheme.name,
    config: parsedTheme.data,
    updatedAt: storedTheme.updatedAt,
  };
});
