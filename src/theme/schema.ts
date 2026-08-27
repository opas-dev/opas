// ABOUTME: Validates the complete runtime theme contract stored in the database.
// ABOUTME: Restricts CSS-bound values to formats that cannot inject additional declarations.
import { z } from "zod";

const oklchPattern = /^oklch\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)\)$/;

const oklchSchema = z.string().superRefine((value, context) => {
  const match = oklchPattern.exec(value);
  if (!match) {
    context.addIssue({
      code: "custom",
      message: "Expected oklch(lightness chroma hue) using plain numeric values",
    });
    return;
  }

  const lightness = Number(match[1]);
  const chroma = Number(match[2]);
  const hue = Number(match[3]);

  if (lightness > 1 || chroma > 0.5 || hue > 360) {
    context.addIssue({
      code: "custom",
      message: "OKLCH channels must be within 0–1, 0–0.5, and 0–360",
    });
  }
});

const fontFamily = String.raw`(?:-?[A-Za-z][A-Za-z0-9-]*(?: [A-Za-z0-9-]+)*|"[A-Za-z0-9 _-]+"|'[A-Za-z0-9 _-]+')`;
const fontStackPattern = new RegExp(`^${fontFamily}(?:, ?${fontFamily})*$`);

const fontStackSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(fontStackPattern, "Expected a comma-separated list of safe font family names");

const radiusPattern = /^(?:0|(?:0|[1-9]\d*)(?:\.\d+)?(?:rem|px))$/;

const radiusSchema = z
  .string()
  .regex(radiusPattern, "Expected zero or a non-negative rem/px length")
  .refine((value) => {
    if (value === "0") {
      return true;
    }

    const amount = Number.parseFloat(value);
    return value.endsWith("rem") ? amount <= 4 : amount <= 64;
  }, "Radius must not exceed 4rem or 64px");

function hasUnsafeUrlCharacter(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 32 || codePoint === 127 || "\\<>\"'".includes(character);
  });
}

const logoUrlSchema = z
  .string()
  .max(2_048)
  .refine((value) => {
    if (hasUnsafeUrlCharacter(value)) {
      return false;
    }

    if (value.startsWith("/")) {
      return !value.startsWith("//");
    }

    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.hostname !== ""
      );
    } catch {
      return false;
    }
  }, "Logo URL must be a same-origin path or an HTTPS URL")
  .nullable();

const colorVariantSchema = z.strictObject({
  background: oklchSchema,
  foreground: oklchSchema,
  surface: oklchSchema,
  surfaceStrong: oklchSchema,
  surfaceElevated: oklchSchema,
  muted: oklchSchema,
  border: oklchSchema,
  borderStrong: oklchSchema,
  primary: oklchSchema,
  primaryForeground: oklchSchema,
  secondary: oklchSchema,
  secondaryForeground: oklchSchema,
  accent: oklchSchema,
  accentForeground: oklchSchema,
  success: oklchSchema,
  successForeground: oklchSchema,
  warning: oklchSchema,
  warningForeground: oklchSchema,
  danger: oklchSchema,
  dangerForeground: oklchSchema,
  focus: oklchSchema,
  codeBackground: oklchSchema,
  codeForeground: oklchSchema,
});

export const themeSchema = z.strictObject({
  logoUrl: logoUrlSchema,
  fonts: z.strictObject({
    sans: fontStackSchema,
    mono: fontStackSchema,
  }),
  radius: z.strictObject({
    xs: radiusSchema,
    sm: radiusSchema,
    md: radiusSchema,
    lg: radiusSchema,
    xl: radiusSchema,
  }),
  light: colorVariantSchema,
  dark: colorVariantSchema,
});

export type ThemeConfig = z.infer<typeof themeSchema>;
