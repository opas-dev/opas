// ABOUTME: Presents the authenticated admin surface for runtime theme changes.
// ABOUTME: Loads the active workspace theme and safe previews for all bundled presets.
import type { Metadata } from "next";

import { AdminHeader } from "@/app/admin/header";
import { ThemeEditor, type ThemePresetPreview } from "@/app/admin/theme/editor";
import {
  themePresetIds,
  themePresetOptions,
} from "@/app/admin/theme/options";
import { findThemePreset } from "@/app/admin/theme/validation";
import { requireMemberCapability } from "@/auth/admin";
import { demoIds } from "@/db/demo";
import { getCurrentTheme } from "@/theme/current";
import { themePresets } from "@/theme/presets";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Theme",
  description: "Manage the runtime theme for the OPAS help center.",
};

function presetPreviews(): ThemePresetPreview[] {
  return themePresetIds.map((id) => ({
    id,
    ...themePresetOptions[id],
    colors: {
      background: themePresets[id].light.background,
      surface: themePresets[id].light.surface,
      primary: themePresets[id].light.primary,
      accent: themePresets[id].light.accent,
    },
  }));
}

export default async function ThemeAdminPage() {
  const admin = await requireMemberCapability("workspace:configure", demoIds.workspace);
  const theme = await getCurrentTheme();

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AdminHeader member={admin} active="theme" />

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="mb-10 max-w-3xl">
          <p className="m-0 text-sm font-semibold text-primary">Workspace appearance</p>
          <h1 className="mb-0 mt-3 text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">
            Theme the help center at runtime.
          </h1>
          <p className="mb-0 mt-4 max-w-2xl text-base leading-7 text-muted text-pretty">
            Start with a preset or edit the complete token JSON. Saving updates the database, so
            readers see the new identity after reloading—without a deployment.
          </p>
        </div>

        <ThemeEditor
          initialName={theme.name}
          initialConfigJson={JSON.stringify(theme.config, null, 2)}
          initialActivePreset={findThemePreset(theme.name, theme.config)}
          presets={presetPreviews()}
        />
      </div>
    </main>
  );
}
