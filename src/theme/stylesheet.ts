// ABOUTME: Serializes a validated runtime theme into deterministic semantic CSS variables.
// ABOUTME: Emits light defaults and dark values without allowing arbitrary token names.
import { themeSchema, type ThemeConfig } from "@/theme/schema";

const colorTokens = [
  ["background", "background"],
  ["foreground", "foreground"],
  ["surface", "surface"],
  ["surfaceStrong", "surface-strong"],
  ["surfaceElevated", "surface-elevated"],
  ["muted", "muted"],
  ["border", "border"],
  ["borderStrong", "border-strong"],
  ["primary", "primary"],
  ["primaryForeground", "primary-foreground"],
  ["secondary", "secondary"],
  ["secondaryForeground", "secondary-foreground"],
  ["accent", "accent"],
  ["accentForeground", "accent-foreground"],
  ["success", "success"],
  ["successForeground", "success-foreground"],
  ["warning", "warning"],
  ["warningForeground", "warning-foreground"],
  ["danger", "danger"],
  ["dangerForeground", "danger-foreground"],
  ["focus", "focus"],
  ["codeBackground", "code-background"],
  ["codeForeground", "code-foreground"],
] as const satisfies ReadonlyArray<readonly [keyof ThemeConfig["light"], string]>;

const fontTokens = [
  ["sans", "font-sans"],
  ["mono", "font-mono"],
] as const satisfies ReadonlyArray<readonly [keyof ThemeConfig["fonts"], string]>;

const radiusTokens = [
  ["xs", "radius-xs"],
  ["sm", "radius-sm"],
  ["md", "radius-md"],
  ["lg", "radius-lg"],
  ["xl", "radius-xl"],
] as const satisfies ReadonlyArray<readonly [keyof ThemeConfig["radius"], string]>;

function colorDeclarations(
  theme: ThemeConfig,
  variant: "light" | "dark",
  indentation: string,
) {
  return colorTokens.map(
    ([key, token]) => `${indentation}--opas-${token}: ${theme[variant][key]};`,
  );
}

export function themeStylesheet(value: unknown) {
  const theme = themeSchema.parse(value);
  const lightDeclarations = [
    ...colorDeclarations(theme, "light", "  "),
    ...fontTokens.map(
      ([key, token]) => `  --opas-${token}: ${theme.fonts[key]};`,
    ),
    ...radiusTokens.map(
      ([key, token]) => `  --opas-${token}: ${theme.radius[key]};`,
    ),
  ];
  const darkDeclarations = colorDeclarations(theme, "dark", "    ");

  return [
    ":root {",
    ...lightDeclarations,
    "}",
    "",
    "@media (prefers-color-scheme: dark) {",
    "  :root {",
    ...darkDeclarations,
    "  }",
    "}",
    "",
  ].join("\n");
}
