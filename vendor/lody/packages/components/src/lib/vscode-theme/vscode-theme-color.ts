import type { LodyResolvedVSCodeTheme } from './vscode-theme-schemas';

type RgbColor = {
  r: number;
  g: number;
  b: number;
};

type RgbaColor = RgbColor & {
  a: number;
};

export const asVSCodeCssVariableName = (colorId: string): string =>
  `--vscode-${colorId.replace(/\./g, '-')}`;

export const normalizeHexColor = (color: string): string => {
  const trimmed = color.trim();
  if (!trimmed.startsWith('#')) {
    throw new Error(`Expected hex color, got "${color}"`);
  }
  const hex = trimmed.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    const expanded = hex
      .split('')
      .map((char) => `${char}${char}`)
      .join('');
    return `#${expanded.toUpperCase()}`;
  }
  if (hex.length === 6 || hex.length === 8) {
    return `#${hex.toUpperCase()}`;
  }
  throw new Error(`Expected #RGB, #RGBA, #RRGGBB, or #RRGGBBAA color, got "${color}"`);
};

export const hexColorToRgb = (color: string): RgbColor => {
  const normalized = normalizeHexColor(color);
  const hex = normalized.slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
};

export const hexColorToRgba = (color: string): RgbaColor => {
  const normalized = normalizeHexColor(color);
  const hex = normalized.slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
};

export const isHexColorFullyTransparent = (color: string): boolean => hexColorToRgba(color).a === 0;

export const compositeHexColors = (foreground: string, background: string): string => {
  const fg = hexColorToRgba(foreground);
  const bg = hexColorToRgba(background);

  const alpha = fg.a + bg.a * (1 - fg.a);
  if (alpha <= 0) {
    return '#000000';
  }

  const compositeChannel = (fgChannel: number, bgChannel: number) =>
    Math.round((fgChannel * fg.a + bgChannel * bg.a * (1 - fg.a)) / alpha);

  const r = compositeChannel(fg.r, bg.r);
  const g = compositeChannel(fg.g, bg.g);
  const b = compositeChannel(fg.b, bg.b);

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

export const hexColorToHslChannel = (color: string): string => {
  const { r, g, b } = hexColorToRgb(color);
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;

  if (max === min) {
    return `0 0% ${toPercent(lightness)}%`;
  }

  const delta = max - min;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;

  if (max === red) {
    hue = 60 * (((green - blue) / delta) % 6);
  } else if (max === green) {
    hue = 60 * ((blue - red) / delta + 2);
  } else {
    hue = 60 * ((red - green) / delta + 4);
  }

  if (hue < 0) {
    hue += 360;
  }

  return `${toDegrees(hue)} ${toPercent(saturation)}% ${toPercent(lightness)}%`;
};

export const readWorkbenchColor = (
  theme: Pick<LodyResolvedVSCodeTheme, 'colors'>,
  colorIds: readonly string[]
): string | undefined => {
  for (const colorId of colorIds) {
    const color = theme.colors[colorId];
    if (color) {
      return color;
    }
  }
  return undefined;
};

const toDegrees = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

const toPercent = (value: number): string => {
  const rounded = Math.round(value * 1000) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

const toHex = (value: number): string => value.toString(16).padStart(2, '0').toUpperCase();
