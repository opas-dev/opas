// ABOUTME: Verifies the runtime theme schema, bundled presets, and CSS serialization contract.
// ABOUTME: Guards the fixed token surface against omissions and CSS injection values.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  findThemePreset,
  parseThemeRequest,
} from "@/app/admin/theme/validation";
import { themePresets } from "@/theme/presets";
import { themeSchema } from "@/theme/schema";
import { themeStylesheet } from "@/theme/stylesheet";

const colorTokens = [
  "background",
  "foreground",
  "surface",
  "surface-strong",
  "surface-elevated",
  "muted",
  "border",
  "border-strong",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "accent",
  "accent-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "danger",
  "danger-foreground",
  "focus",
  "code-background",
  "code-foreground",
] as const;

const structuralTokens = [
  "font-sans",
  "font-mono",
  "radius-xs",
  "radius-sm",
  "radius-md",
  "radius-lg",
  "radius-xl",
] as const;

test("all four preset themes satisfy the complete strict schema", () => {
  assert.deepEqual(Object.keys(themePresets), ["opas", "graphite", "ocean", "grove"]);

  for (const [name, preset] of Object.entries(themePresets)) {
    assert.deepEqual(themeSchema.parse(preset), preset, `${name} preset is invalid`);
  }

  const missingToken = structuredClone(themePresets.opas) as unknown as Record<
    string,
    unknown
  >;
  delete (missingToken.light as Record<string, unknown>).accent;
  assert.equal(themeSchema.safeParse(missingToken).success, false);

  const extraToken = structuredClone(themePresets.opas) as unknown as Record<
    string,
    unknown
  >;
  (extraToken.dark as Record<string, unknown>).brand = "oklch(0.5 0.1 100)";
  assert.equal(themeSchema.safeParse(extraToken).success, false);
});

test("CSS-bound values reject declaration and selector injection", () => {
  const attacks = [
    ["light", "primary", "oklch(0.5 0.1 20); } body { color: red"],
    ["fonts", "sans", "Inter; color: red"],
    ["radius", "md", "0; } body { display: none"],
  ] as const;

  for (const [group, token, attack] of attacks) {
    const candidate = structuredClone(themePresets.opas) as unknown as Record<
      string,
      unknown
    >;
    (candidate[group] as Record<string, unknown>)[token] = attack;

    assert.equal(themeSchema.safeParse(candidate).success, false, `${group}.${token}`);
    assert.throws(() => themeStylesheet(candidate));
  }

  for (const color of [
    "red",
    "oklch(1.1 0.1 20)",
    "oklch(0.5 0.6 20)",
    "oklch(0.5 0.1 361)",
  ]) {
    const candidate = structuredClone(themePresets.opas);
    candidate.light.primary = color;
    assert.equal(themeSchema.safeParse(candidate).success, false, color);
  }
});

test("logo accepts only null, same-origin paths, and HTTPS URLs", () => {
  for (const logoUrl of [
    null,
    "/brand/opas.svg",
    "/brand/opas.svg?v=2#mark",
    "https://cdn.example.com/opas/logo.svg",
  ]) {
    assert.equal(
      themeSchema.safeParse({ ...themePresets.opas, logoUrl }).success,
      true,
      String(logoUrl),
    );
  }

  for (const logoUrl of [
    "logo.svg",
    "//cdn.example.com/logo.svg",
    "http://cdn.example.com/logo.svg",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "javascript:alert(1)",
    "https://user:secret@cdn.example.com/logo.svg",
  ]) {
    assert.equal(
      themeSchema.safeParse({ ...themePresets.opas, logoUrl }).success,
      false,
      logoUrl,
    );
  }
});

test("stylesheet emits every fixed token in deterministic light and dark blocks", () => {
  const stylesheet = themeStylesheet(themePresets.opas);
  assert.equal(stylesheet, themeStylesheet(themePresets.opas));
  assert.ok(stylesheet.startsWith(":root {\n"));
  assert.ok(stylesheet.includes("\n@media (prefers-color-scheme: dark) {\n  :root {\n"));
  assert.ok(stylesheet.endsWith("}\n"));

  const declarationNames = stylesheet
    .split("\n")
    .filter((line) => line.trimStart().startsWith("--opas-"))
    .map((line) => {
      const declaration = line.trim();
      return declaration.slice(2, declaration.indexOf(":"));
    });
  const expectedNames = [
    ...colorTokens.map((token) => `opas-${token}`),
    ...structuralTokens.map((token) => `opas-${token}`),
    ...colorTokens.map((token) => `opas-${token}`),
  ];

  assert.deepEqual(declarationNames, expectedNames);

  for (const token of colorTokens) {
    assert.equal(stylesheet.split(`--opas-${token}:`).length - 1, 2, token);
  }

  for (const token of structuralTokens) {
    assert.equal(stylesheet.split(`--opas-${token}:`).length - 1, 1, token);
  }

  assert.ok(stylesheet.includes(`--opas-primary: ${themePresets.opas.light.primary};`));
  assert.ok(stylesheet.includes(`--opas-primary: ${themePresets.opas.dark.primary};`));
});

test("Tailwind maps the complete semantic namespace through runtime variables", () => {
  const globals = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  assert.ok(globals.includes("@theme inline"));

  for (const token of colorTokens) {
    assert.ok(
      globals.includes(`--color-${token}: var(--opas-${token});`),
      `missing color mapping for ${token}`,
    );
  }

  for (const token of structuralTokens) {
    const [group, ...nameParts] = token.split("-");
    const name = nameParts.join("-");
    assert.ok(
      globals.includes(`--${group}-${name}: var(--opas-${token});`),
      `missing structural mapping for ${token}`,
    );
  }
});

test("admin theme requests accept only known presets and strict theme JSON", () => {
  const presetRequest = new FormData();
  presetRequest.set("intent", "preset");
  presetRequest.set("preset", "ocean");
  assert.deepEqual(parseThemeRequest(presetRequest), {
    success: true,
    data: { kind: "preset", preset: "ocean" },
  });

  const unknownPreset = new FormData();
  unknownPreset.set("intent", "preset");
  unknownPreset.set("preset", "nightfall");
  assert.equal(parseThemeRequest(unknownPreset).success, false);

  const jsonRequest = new FormData();
  jsonRequest.set("intent", "json");
  jsonRequest.set("name", "  Custom support theme  ");
  jsonRequest.set("config", JSON.stringify(themePresets.grove));
  const parsedJson = parseThemeRequest(jsonRequest);
  assert.equal(parsedJson.success, true);
  if (parsedJson.success) {
    assert.equal(parsedJson.data.kind, "json");
    if (parsedJson.data.kind === "json") {
      assert.equal(parsedJson.data.name, "Custom support theme");
      assert.deepEqual(parsedJson.data.config, themePresets.grove);
    }
  }

  const extraThemeToken = structuredClone(themePresets.opas) as unknown as Record<
    string,
    unknown
  >;
  extraThemeToken.untrusted = "value";
  jsonRequest.set("config", JSON.stringify(extraThemeToken));
  assert.equal(parseThemeRequest(jsonRequest).success, false);

  jsonRequest.set("config", "{not-json}");
  assert.equal(parseThemeRequest(jsonRequest).success, false);

  jsonRequest.set("config", JSON.stringify(themePresets.opas));
  jsonRequest.set("workspaceId", "workspace_untrusted");
  assert.equal(parseThemeRequest(jsonRequest).success, false);
});

test("admin marks a preset active only when its name and complete config match", () => {
  assert.equal(findThemePreset("Ocean", themePresets.ocean), "ocean");
  assert.equal(findThemePreset("Ocean", themePresets.opas), null);
  assert.equal(findThemePreset("Custom", themePresets.ocean), null);

  const reorderedOcean = Object.fromEntries(
    Object.entries(themePresets.ocean).reverse(),
  ) as typeof themePresets.ocean;
  assert.equal(findThemePreset("Ocean", reorderedOcean), "ocean");
});
