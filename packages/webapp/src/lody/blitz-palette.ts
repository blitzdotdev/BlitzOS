/**
 * The BlitzOS palette, as concrete hex colours a VS Code theme can carry.
 *
 * `packages/webapp/src/tokens.css` is the source of truth, and it states the
 * palette in two halves:
 *
 * - BASE tokens are plain hex literals — `--paper`, `--ink`, `--accent`,
 *   `--live` and the sixteen ANSI names. A browser hands those back verbatim
 *   from `getComputedStyle(:root).getPropertyValue(name)`, because an
 *   unregistered custom property computes to its token stream and a hex literal
 *   is already finished.
 * - DERIVED tokens are `color-mix(in oklab, <base> <ratio>, <base>)`. Those do
 *   NOT come back as a colour: the computed value is still the `color-mix()`
 *   expression, with the `var()`s substituted. So this module performs the same
 *   mix, in OKLab, in TypeScript.
 *
 * WHY DERIVE RATHER THAN RESTATE. Lody's theme engine needs `#RRGGBB`, and the
 * five-collision note in `lody-surface-shell.css` warned that hand-computing
 * those mixes into literals "would fork our palette into a second, silently
 * drifting copy". Deriving them keeps ONE copy of the palette: change
 * `--paper`, `--ink` or `--accent` in `tokens.css` and every colour the Lody
 * surface paints moves with it. What stays duplicated is the RATIO of each mix,
 * and `packages/webapp/test/lody-blitz-theme.test.ts` parses `tokens.css` and
 * fails if a ratio here disagrees with the one declared there.
 *
 * WHY THE FALLBACKS EXIST. jsdom does not cascade custom properties, so
 * `getPropertyValue` returns `""` under Vitest. The fallbacks are the same
 * literals `tokens.css` declares, each named beside its token, and they are
 * what the tests measure — the browser reads the real thing.
 */

/** Which half of `tokens.css` a palette is being read for. */
export type BlitzThemeMode = "dark" | "light";

/** The sixteen ANSI names, in `tokens.css` order. */
export const BLITZ_ANSI_TOKENS = [
  "--ansi-black",
  "--ansi-red",
  "--ansi-green",
  "--ansi-yellow",
  "--ansi-blue",
  "--ansi-magenta",
  "--ansi-cyan",
  "--ansi-white",
  "--ansi-bright-black",
  "--ansi-bright-red",
  "--ansi-bright-green",
  "--ansi-bright-yellow",
  "--ansi-bright-blue",
  "--ansi-bright-magenta",
  "--ansi-bright-cyan",
  "--ansi-bright-white",
] as const;

export type BlitzAnsiToken = (typeof BLITZ_ANSI_TOKENS)[number];

/** A token `tokens.css` states as a hex literal, and this module reads verbatim. */
export type BlitzBaseToken = "--paper" | "--ink" | "--accent" | "--live" | BlitzAnsiToken;

/** A token `tokens.css` states as a `color-mix(in oklab, …)` of two base tokens. */
export type BlitzDerivedToken =
  | "--muted"
  | "--faint"
  | "--soft-ink"
  | "--rule"
  | "--hover"
  | "--sunken"
  | "--selected";

/** One `color-mix(in oklab, var(<from>) <percent>%, var(<over>))` recipe. */
export interface BlitzMixRecipe {
  readonly from: BlitzBaseToken;
  readonly over: BlitzBaseToken;
  readonly percent: number;
}

/** Every colour the Blitz VS Code theme is built out of, all `#RRGGBB`. */
export interface BlitzPalette {
  readonly mode: BlitzThemeMode;
  /** `--paper`: the page. */
  readonly paper: string;
  /** `--ink`: body text. */
  readonly ink: string;
  /** `--accent`: the one accent colour, and the only saturated chrome. */
  readonly accent: string;
  /** `--live`: a running session. */
  readonly live: string;
  /** `--muted`: prose one step below `--ink`. */
  readonly muted: string;
  /** `--faint`: metadata, glyphs, timestamps. */
  readonly faint: string;
  /** `--soft-ink`: control labels — one step below `--ink`, above `--muted`. */
  readonly softInk: string;
  /** `--rule`: every quiet border in the product. */
  readonly rule: string;
  /** `--hover`: the hover wash on a row or an icon button. */
  readonly hover: string;
  /** `--sunken`: a recessed slab — code blocks, command output. */
  readonly sunken: string;
  /** `--selected`: the selected row's accent wash. */
  readonly selected: string;
  /** The ANSI ramp, keyed by token name. */
  readonly ansi: Readonly<Record<BlitzAnsiToken, string>>;
}

/**
 * The base literals, verbatim from `tokens.css`.
 *
 * `dark` mirrors the `:root` block and `:root[data-theme='dark']`; `light`
 * mirrors the `@media (prefers-color-scheme: light)` block and
 * `:root[data-theme='light']`, which declare the same values.
 */
const BASE_LITERALS = {
  dark: {
    "--paper": "#16181d",
    "--ink": "#dfe2e8",
    "--accent": "#7e95d7",
    "--live": "#7fd39b",
    "--ansi-black": "#292c33",
    "--ansi-red": "#c47f86",
    "--ansi-green": "#8fa879",
    "--ansi-yellow": "#b7a06b",
    "--ansi-blue": "#7e95d7",
    "--ansi-magenta": "#a88abb",
    "--ansi-cyan": "#78a7ad",
    "--ansi-white": "#c4c8d0",
    "--ansi-bright-black": "#6f747f",
    "--ansi-bright-red": "#d59299",
    "--ansi-bright-green": "#a3ba8d",
    "--ansi-bright-yellow": "#c9b37c",
    "--ansi-bright-blue": "#9aace3",
    "--ansi-bright-magenta": "#bc9bca",
    "--ansi-bright-cyan": "#8ebbc0",
    "--ansi-bright-white": "#e7e9ee",
  },
  light: {
    "--paper": "#f7f7f4",
    "--ink": "#1c1f26",
    "--accent": "#4c62aa",
    "--live": "#3f8156",
    "--ansi-black": "#d9dbde",
    "--ansi-red": "#a34e56",
    "--ansi-green": "#5f7d46",
    "--ansi-yellow": "#8a6d28",
    "--ansi-blue": "#4c62aa",
    "--ansi-magenta": "#7d548f",
    "--ansi-cyan": "#397a83",
    "--ansi-white": "#6f747f",
    "--ansi-bright-black": "#9aa0a8",
    "--ansi-bright-red": "#b4636b",
    "--ansi-bright-green": "#6f8f55",
    "--ansi-bright-yellow": "#9c7f37",
    "--ansi-bright-blue": "#5f77bd",
    "--ansi-bright-magenta": "#8f66a2",
    "--ansi-bright-cyan": "#4b8b95",
    "--ansi-bright-white": "#1c1f26",
  },
} as const satisfies Record<BlitzThemeMode, Readonly<Record<BlitzBaseToken, string>>>;

/**
 * The `color-mix(in oklab, …)` recipes `tokens.css` declares, as
 * `[foreground token, its percentage]` over `--paper`.
 *
 * `--selected` is the one recipe that differs between the two modes: the light
 * palette dials the accent wash back to 16%, because the same 20% over white
 * paper reads as a filled button rather than a selection.
 */
const MIX_RATIOS = {
  dark: {
    "--muted": { from: "--ink", percent: 52, over: "--paper" },
    "--faint": { from: "--ink", percent: 30, over: "--paper" },
    "--soft-ink": { from: "--ink", percent: 82, over: "--paper" },
    "--rule": { from: "--ink", percent: 13, over: "--paper" },
    "--hover": { from: "--ink", percent: 7, over: "--paper" },
    "--sunken": { from: "--ink", percent: 5, over: "--paper" },
    "--selected": { from: "--accent", percent: 20, over: "--paper" },
  },
  light: {
    "--muted": { from: "--ink", percent: 52, over: "--paper" },
    "--faint": { from: "--ink", percent: 30, over: "--paper" },
    "--soft-ink": { from: "--ink", percent: 82, over: "--paper" },
    "--rule": { from: "--ink", percent: 13, over: "--paper" },
    "--hover": { from: "--ink", percent: 6, over: "--paper" },
    "--sunken": { from: "--ink", percent: 5, over: "--paper" },
    "--selected": { from: "--accent", percent: 16, over: "--paper" },
  },
} as const satisfies Record<BlitzThemeMode, Readonly<Record<BlitzDerivedToken, BlitzMixRecipe>>>;

/** The ratio table, for the test that pins it against `tokens.css`. */
export const BLITZ_MIX_RATIOS: Readonly<typeof MIX_RATIOS> = MIX_RATIOS;

/** The literal table, for the test that pins it against `tokens.css`. */
export const BLITZ_BASE_LITERALS: Readonly<typeof BASE_LITERALS> = BASE_LITERALS;

/**
 * Reads one base token off `:root`, or falls back to the literal `tokens.css`
 * declares for `mode`.
 *
 * A browser answers with the hex literal. jsdom answers with `""`, because its
 * cascade does not carry custom properties — the same limitation
 * `lody-tailwind-containment.test.ts` documents at the top.
 */
function readBaseToken(root: Element | null, mode: BlitzThemeMode, token: BlitzBaseToken): string {
  const fallback = BASE_LITERALS[mode][token];
  if (root === null) return fallback;
  const declared = getComputedStyle(root).getPropertyValue(token).trim();
  return isHexColor(declared) ? declared : fallback;
}

function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/**
 * The palette for one mode.
 *
 * `root` is the element the base tokens are read from — `document.documentElement`
 * in the app, `null` where there is no document. Pass the element only when it
 * already carries the mode being asked for: a `data-theme='light'` root and
 * `mode: 'dark'` would mix light literals into a dark theme.
 */
export function readBlitzPalette(root: Element | null, mode: BlitzThemeMode): BlitzPalette {
  const base = (token: BlitzBaseToken): string => readBaseToken(root, mode, token);
  const derive = (token: BlitzDerivedToken): string => {
    const recipe = MIX_RATIOS[mode][token];
    return mixOklab(base(recipe.from), base(recipe.over), recipe.percent / 100);
  };

  // SAFETY: the loop below assigns every member of `BLITZ_ANSI_TOKENS`, and
  // `BlitzAnsiToken` is defined AS that tuple's member union — so the key set of
  // the target type and the set the loop fills are the same set by construction.
  const ansi = {} as Record<BlitzAnsiToken, string>;
  for (const token of BLITZ_ANSI_TOKENS) ansi[token] = base(token);

  return {
    mode,
    paper: base("--paper"),
    ink: base("--ink"),
    accent: base("--accent"),
    live: base("--live"),
    muted: derive("--muted"),
    faint: derive("--faint"),
    softInk: derive("--soft-ink"),
    rule: derive("--rule"),
    hover: derive("--hover"),
    sunken: derive("--sunken"),
    selected: derive("--selected"),
    ansi,
  };
}

/* ------------------------------------------------------------------ OKLab */
/*
 * `color-mix(in oklab, A p%, B)`, for two opaque sRGB colours: convert both to
 * OKLab, interpolate each channel at `p`, convert back and clamp into gamut.
 * The matrices are Björn Ottosson's, which is what CSS Color 4 specifies.
 */

interface Lab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

/** Mixes `from` into `over` at `ratio` (0..1) in OKLab, as CSS would. */
export function mixOklab(from: string, over: string, ratio: number): string {
  const a = srgbToOklab(parseHex(from));
  const b = srgbToOklab(parseHex(over));
  const lerp = (first: number, second: number): number => second + (first - second) * ratio;
  return formatHex(
    oklabToSrgb({ l: lerp(a.l, b.l), a: lerp(a.a, b.a), b: lerp(a.b, b.b) }),
  );
}

function parseHex(color: string): readonly [number, number, number] {
  const hex = color.trim().slice(1);
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : hex;
  if (full.length < 6) throw new Error(`Expected #RGB or #RRGGBB, got "${color}"`);
  return [
    Number.parseInt(full.slice(0, 2), 16) / 255,
    Number.parseInt(full.slice(2, 4), 16) / 255,
    Number.parseInt(full.slice(4, 6), 16) / 255,
  ];
}

function formatHex(channels: readonly [number, number, number]): string {
  const byte = (value: number): string => {
    const clamped = Math.min(255, Math.max(0, Math.round(value * 255)));
    return clamped.toString(16).padStart(2, "0");
  };
  return `#${byte(channels[0])}${byte(channels[1])}${byte(channels[2])}`;
}

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function toGamma(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

function srgbToOklab(rgb: readonly [number, number, number]): Lab {
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);
  const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    a: 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    b: 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  };
}

function oklabToSrgb(lab: Lab): readonly [number, number, number] {
  const long = (lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b) ** 3;
  const medium = (lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b) ** 3;
  const short = (lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b) ** 3;
  return [
    toGamma(4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short),
    toGamma(-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short),
    toGamma(-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short),
  ];
}
