import { z } from 'zod';

const HexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);

const UiThemeSchema = z.enum(['vs', 'vs-dark', 'hc-light', 'hc-black']);

export const VSCodeThemeContributionSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1),
    uiTheme: UiThemeSchema,
    path: z.string().trim().min(1),
  })
  .passthrough();

export const VSCodeExtensionManifestSchema = z
  .object({
    name: z.string().trim().min(1),
    displayName: z.string().trim().min(1).optional(),
    publisher: z.string().trim().min(1).optional(),
    version: z.string().trim().min(1).optional(),
    contributes: z
      .object({
        themes: z.array(VSCodeThemeContributionSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const TextMateTokenColorRuleSchema = z
  .object({
    name: z.string().optional(),
    scope: z.union([z.string(), z.array(z.string())]).optional(),
    settings: z.object({
      foreground: HexColorSchema.optional(),
      background: HexColorSchema.optional(),
      fontStyle: z.string().optional(),
    }),
  })
  .strict();

export const VSCodeColorThemeJsonSchema = z
  .object({
    name: z.string().optional(),
    type: z.string().optional(),
    include: z.string().optional(),
    colors: z.record(z.string(), z.unknown()).optional(),
    tokenColors: z.union([z.array(z.unknown()), z.string()]).optional(),
    semanticTokenColors: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const LodyResolvedVSCodeThemeSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    type: z.enum(['light', 'dark', 'hcLight', 'hcDark']),
    source: z
      .object({
        kind: z.enum(['builtin', 'extension-directory', 'vsix', 'test-fixture']),
        extensionId: z.string().trim().min(1).optional(),
        extensionVersion: z.string().trim().min(1).optional(),
      })
      .strict(),
    colors: z.record(z.string(), HexColorSchema),
    tokenColors: z.array(TextMateTokenColorRuleSchema),
    semanticTokenColors: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const ThemeSelectionStorageSchema = z
  .object({
    schemaVersion: z.literal(1),
    lightThemeId: z.string().trim().min(1).optional(),
    darkThemeId: z.string().trim().min(1).optional(),
  })
  .strict();

export type VSCodeThemeContribution = z.infer<typeof VSCodeThemeContributionSchema>;
export type VSCodeExtensionManifest = z.infer<typeof VSCodeExtensionManifestSchema>;
export type TextMateTokenColorRule = z.infer<typeof TextMateTokenColorRuleSchema>;
export type LodyResolvedVSCodeTheme = z.infer<typeof LodyResolvedVSCodeThemeSchema>;
export type LodyResolvedVSCodeThemeType = LodyResolvedVSCodeTheme['type'];
export type ThemeSelectionStorage = z.infer<typeof ThemeSelectionStorageSchema>;
