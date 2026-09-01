// ABOUTME: Defines the trusted preset choices presented by the admin theme editor.
// ABOUTME: Keeps stored preset names and user-facing descriptions consistent.
export const themePresetIds = [
  "opas",
  "graphite",
  "ocean",
  "grove",
  "crofusion",
] as const;

export type ThemePresetId = (typeof themePresetIds)[number];

export const themePresetOptions = {
  opas: {
    name: "OPAS Default",
    description: "High-contrast neutrals with a focused crimson signal.",
  },
  graphite: {
    name: "Graphite",
    description: "A compact monochrome system with a precise yellow accent.",
  },
  ocean: {
    name: "Ocean",
    description: "Cool blue surfaces with clear cyan wayfinding.",
  },
  grove: {
    name: "Grove",
    description: "Botanical greens balanced by a warm amber accent.",
  },
  crofusion: {
    name: "CROFusion",
    description: "CROFusion purple with cerulean and salmon brand signals.",
  },
} as const satisfies Record<ThemePresetId, { name: string; description: string }>;
