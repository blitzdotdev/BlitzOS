import {
  parseLodyLogoContours,
  USAGE_CALENDAR_COLUMNS,
  USAGE_CALENDAR_ROWS,
  type UsageCalendarCell,
  type UsageCalendarModel,
} from './usage-calendar-model';
import { waitForUsageShareCardFonts } from './usage-share-card-fonts';

export type UsageShareCardStyle = 'flat' | 'isometric';

export type LodyMarkStyle = 'sticker' | 'outline' | 'plain';

/** The centerpiece graphic. Swap this to recombine the same data into a different story. */
export type UsageShareCardHeroGraphic = 'trend' | 'heatmap' | 'bars';

/** Special-effect treatment for the hero number. `vhs` is a canvas-native CRT/VHS glitch. */
export type UsageShareCardHeroFx = 'none' | 'vhs';

/** Metallic foil stamping applied to the number, chart, sticker and frame. All light-friendly. */
export type UsageShareCardFoil = 'none' | 'silver' | 'platinum' | 'champagne';

/** Ordered light→dark→light stops that read as a reflective metal band. */
const FOIL_PALETTES: Record<Exclude<UsageShareCardFoil, 'none'>, string[]> = {
  silver: ['#ffffff', '#a7afba', '#eef1f5', '#6d7783', '#d5dae1', '#8b94a0', '#fbfcfd'],
  platinum: ['#eef2f6', '#98a1af', '#dfe4eb', '#646e7d', '#c3cbd5', '#828c9b', '#eef2f6'],
  champagne: ['#fdf6e6', '#cda863', '#f4e8c6', '#9c7d3a', '#e4cf99', '#b8934e', '#fdf6e6'],
};

/**
 * Every visual knob of the usage share card, flattened so Storybook can expose
 * each as an individual control (range / color / select). Callers pass a partial
 * override; {@link resolveShareCardConfig} fills the rest from
 * {@link DEFAULT_USAGE_SHARE_CARD_CONFIG}. Tune values in Storybook, copy the
 * emitted JSON, and paste it back here to lock a new default in.
 */
export type UsageShareCardConfig = {
  // Canvas + card silhouette
  width: number;
  height: number;
  marginX: number;
  marginY: number;
  cornerRadius: number;

  // Foil stamping
  foil: UsageShareCardFoil;

  // Paper + frame
  paperTop: string;
  paperBottom: string;
  edgeColor: string;
  frameInset: number;
  showFrame: boolean;
  inkColor: string;
  mutedInk: string;
  accent: string;
  accentSoft: string;
  showGrain: boolean;
  grainOpacity: number;
  shadowOpacity: number;

  // Die-cut: perforated tear + stub + optional stamp scallop
  showStub: boolean;
  tearX: number; // fraction of interior width
  tearInset: number;
  perfRadius: number;
  perfSpacing: number;
  notchRadius: number;
  scallopEdge: boolean;
  scallopRadius: number;
  scallopSpacing: number;

  // Typography
  fontSans: string;
  fontMono: string;
  fontDisplay: string; // the workspace-name title face

  // Main content layout
  contentPadX: number;
  kickerY: number;
  kickerText: string;
  titleY: number;
  heroY: number;
  heroSize: number;
  unitLabel: string;
  subtitleY: number;
  heroFx: UsageShareCardHeroFx;

  // Hero graphic
  showTrend: boolean; // when false, no centerpiece graphic is drawn at all
  heroGraphic: UsageShareCardHeroGraphic;
  chartTop: number;
  chartHeight: number;
  trendLineWidth: number;
  trendDotRadius: number;
  trendFill: boolean;
  showTrendDelta: boolean;

  // Highlight-moment data grid
  showStats: boolean;
  statsY: number;

  // Heatmap strip
  showHeatmap: boolean;
  heatmapTop: number;
  heatmapHeight: number;

  // Lody sticker on the main body
  showMark: boolean;
  markStyle: LodyMarkStyle;
  markFx: UsageShareCardHeroFx;
  markX: number; // center; if < 0 it is measured from the tear line
  markY: number;
  markSize: number;
  markRotation: number; // degrees
  markOpacity: number;
  markFill: string;
  markStroke: string;
  markStrokeWidth: number;

  // Stub
  showStubStamp: boolean;
  stubStampSize: number;
  showBarcode: boolean;
  serial: string; // empty = auto from usage total
};

export const DEFAULT_USAGE_SHARE_CARD_CONFIG: UsageShareCardConfig = {
  width: 1200,
  height: 630,
  marginX: 24,
  marginY: 40,
  cornerRadius: 30,

  foil: 'silver',

  paperTop: '#f5f7fa',
  paperBottom: '#e8ecf2',
  edgeColor: '#cfd6df',
  frameInset: 18,
  showFrame: false,
  inkColor: '#39404a',
  mutedInk: '#98a1ad',
  accent: '#8b93a0',
  accentSoft: '#a4bbea',
  showGrain: true,
  grainOpacity: 0.05,
  shadowOpacity: 0.16,

  showStub: true,
  tearX: 0.81,
  tearInset: 13,
  perfRadius: 3.5,
  perfSpacing: 21,
  notchRadius: 22,
  scallopEdge: false,
  scallopRadius: 8,
  scallopSpacing: 25,

  fontSans: 'Inter, ui-sans-serif, system-ui, sans-serif',
  fontMono: '"JetBrains Mono", ui-monospace, monospace',
  fontDisplay: '"Bitcount Grid Double", "Bricolage Grotesque", ui-sans-serif, sans-serif',

  contentPadX: 36,
  kickerY: 92,
  kickerText: 'LODY · USAGE PASS',
  titleY: 142,
  heroY: 236,
  heroSize: 87,
  unitLabel: 'TOKENS',
  subtitleY: 267,
  heroFx: 'none',

  showTrend: true,
  heroGraphic: 'bars',
  chartTop: 300,
  chartHeight: 150,
  trendLineWidth: 4,
  trendDotRadius: 6,
  trendFill: false,
  showTrendDelta: true,

  showStats: true,
  statsY: 478,

  showHeatmap: true,
  heatmapTop: 548,
  heatmapHeight: 69,

  showMark: true,
  markStyle: 'sticker',
  markFx: 'none',
  markX: -93,
  markY: 108,
  markSize: 78,
  markRotation: -9,
  markOpacity: 1,
  markFill: '#262620',
  markStroke: '#ffffff',
  markStrokeWidth: 10,

  showStubStamp: true,
  stubStampSize: 40,
  showBarcode: true,
  serial: '',
};

export function resolveShareCardConfig(
  overrides?: Partial<UsageShareCardConfig>
): UsageShareCardConfig {
  return { ...DEFAULT_USAGE_SHARE_CARD_CONFIG, ...(overrides ?? {}) };
}

export type UsageShareCardInsights = {
  weeklyTotals: number[];
  peakCell: UsageCalendarCell | null;
  dailyAverage: number;
  trendDelta: number | null;
};

// Blue ramp matching the Usage screen's `--chart-1`, at the same luminance steps
// the previous green ramp used so the printed density still reads the same.
const HEATMAP_LEVEL_COLORS = ['transparent', '#c6d4f1', '#7698db', '#2f5ebc', '#1a3b89'];

/** Deterministic PRNG so the paper grain never flickers between renders. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function formatUsageCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 100_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

export function computeUsageShareInsights(model: UsageCalendarModel): UsageShareCardInsights {
  const weeklyTotals = model.weeks.map((week) =>
    week.reduce((sum, cell) => (cell.isFuture ? sum : sum + cell.value), 0)
  );
  const completed = model.cells.filter((cell) => !cell.isFuture);
  const peakCell = completed.reduce<UsageCalendarCell | null>(
    (peak, cell) => (!peak || cell.value > peak.value ? cell : peak),
    null
  );
  const dailyAverage = completed.length > 0 ? model.totalValue / completed.length : 0;

  const active = weeklyTotals.filter((_, index) =>
    model.weeks[index]!.some((cell) => !cell.isFuture)
  );
  const window = Math.min(4, Math.floor(active.length / 2));
  let trendDelta: number | null = null;
  if (window > 0) {
    const recent = active.slice(active.length - window);
    const prior = active.slice(active.length - window * 2, active.length - window);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / window;
    const priorAvg = prior.reduce((a, b) => a + b, 0) / window;
    if (priorAvg > 0) trendDelta = (recentAvg - priorAvg) / priorAvg;
  }

  return { weeklyTotals, peakCell, dailyAverage, trendDelta };
}

function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) ** 3;
}

// --- Lody mark ------------------------------------------------------------

const lodyContours = parseLodyLogoContours();
const lodyBounds = (() => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const contour of lodyContours) {
    for (const [x, y] of contour) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
})();

function traceLodyPath(context: CanvasRenderingContext2D, scale: number) {
  const centerX = (lodyBounds.minX + lodyBounds.maxX) / 2;
  const centerY = (lodyBounds.minY + lodyBounds.maxY) / 2;
  context.beginPath();
  for (const contour of lodyContours) {
    const [first, ...rest] = contour;
    if (!first) continue;
    context.moveTo((first[0] - centerX) * scale, (first[1] - centerY) * scale);
    for (const point of rest) {
      context.lineTo((point[0] - centerX) * scale, (point[1] - centerY) * scale);
    }
    context.closePath();
  }
}

/** Draw the Lody glyph as a die-cut outline sticker centered on (x, y). */
export function drawLodyMark(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  options: {
    rotation?: number;
    opacity?: number;
    style?: LodyMarkStyle;
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    foil?: string[] | null;
    fx?: UsageShareCardHeroFx;
    progress?: number;
    sizeMultiplier?: number;
  } = {}
) {
  const {
    rotation = 0,
    opacity = 1,
    style = 'sticker',
    stroke = '#ffffff',
    strokeWidth = 8,
    foil = null,
    fx = 'none',
    progress = 1,
    sizeMultiplier = 1,
  } = options;
  const adjustedSize = size * sizeMultiplier;
  const scale = adjustedSize / lodyBounds.height;
  const half = adjustedSize / 2;
  // Foil is built in the mark's local (post-translate/rotate) space.
  const fill = foil
    ? makeFoil(context, -half, -half, adjustedSize, adjustedSize, foil)
    : (options.fill ?? '#262620');

  context.save();
  context.globalAlpha *= opacity;
  context.translate(x, y);
  context.rotate((rotation * Math.PI) / 180);
  context.lineJoin = 'round';
  context.lineCap = 'round';

  if (fx === 'vhs') {
    const markWidth = lodyBounds.width * scale;
    const markHeight = lodyBounds.height * scale;
    const aberration = 2.4 + Math.sin(progress * 34) * 1.3;
    // Keep the die-cut paper halo so the glitchy mark still reads as a sticker.
    context.save();
    context.shadowColor = 'rgba(28,26,20,0.22)';
    context.shadowBlur = adjustedSize * 0.14;
    context.shadowOffsetY = adjustedSize * 0.05;
    traceLodyPath(context, scale);
    context.lineWidth = strokeWidth;
    context.strokeStyle = stroke;
    context.stroke();
    context.restore();
    // RGB channel split.
    context.save();
    context.globalCompositeOperation = 'multiply';
    context.save();
    context.translate(-aberration, 0);
    traceLodyPath(context, scale);
    context.fillStyle = '#ff2b2b';
    context.fill('evenodd');
    context.restore();
    context.save();
    context.translate(aberration, 0);
    traceLodyPath(context, scale);
    context.fillStyle = '#12e8ff';
    context.fill('evenodd');
    context.restore();
    context.globalAlpha = 0.85;
    traceLodyPath(context, scale);
    context.fillStyle = '#1b1a24';
    context.fill('evenodd');
    context.restore();
    // Scanlines over the mark box.
    context.save();
    context.beginPath();
    context.rect(
      -markWidth / 2 - aberration,
      -markHeight / 2,
      markWidth + aberration * 2,
      markHeight
    );
    context.clip();
    context.fillStyle = 'rgba(255,255,255,0.4)';
    for (let ly = -markHeight / 2; ly < markHeight / 2; ly += 3) {
      context.fillRect(-markWidth / 2 - aberration, ly, markWidth + aberration * 2, 1.2);
    }
    context.restore();
  } else if (style === 'sticker') {
    // A thick same-color-as-paper stroke traces the glyph, producing the white
    // die-cut border; the fill then sits inside it.
    context.save();
    context.shadowColor = 'rgba(28,26,20,0.22)';
    context.shadowBlur = adjustedSize * 0.14;
    context.shadowOffsetY = adjustedSize * 0.05;
    traceLodyPath(context, scale);
    context.lineWidth = strokeWidth;
    context.strokeStyle = stroke;
    context.stroke();
    context.restore();
    traceLodyPath(context, scale);
    context.fillStyle = fill;
    context.fill('evenodd');
  } else if (style === 'outline') {
    traceLodyPath(context, scale);
    context.lineWidth = strokeWidth;
    context.strokeStyle = stroke;
    context.stroke();
  } else {
    traceLodyPath(context, scale);
    context.fillStyle = fill;
    context.fill('evenodd');
  }
  context.restore();
}

// --- Geometry helpers -----------------------------------------------------

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function punchHole(context: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
}

/** A decorative, deterministic QR-style block with three finder eyes and rounded modules. */
function drawFauxQr(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  seed: number,
  foreground: string,
  background: string
) {
  const modules = 21;
  const quiet = 1;
  const cell = size / (modules + quiet * 2);
  const random = mulberry32(seed >>> 0);
  const inFinder = (row: number, col: number) =>
    (row < 7 && col < 7) || (row < 7 && col >= modules - 7) || (row >= modules - 7 && col < 7);
  const px = (col: number) => x + (col + quiet) * cell;
  const py = (row: number) => y + (row + quiet) * cell;

  const inset = cell * 0.08;
  const finders: Array<[number, number]> = [
    [0, 0],
    [0, modules - 7],
    [modules - 7, 0],
  ];
  context.save();

  // Data modules + finder outer rings — one accumulated path, one fill.
  context.beginPath();
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (inFinder(row, col) || random() < 0.52) continue;
      context.rect(px(col) + inset, py(row) + inset, cell - inset * 2, cell - inset * 2);
    }
  }
  for (const [row, col] of finders) context.rect(px(col), py(row), cell * 7, cell * 7);
  context.fillStyle = foreground;
  context.fill();

  // Finder inner gaps (background) then centres (foreground).
  context.beginPath();
  for (const [row, col] of finders)
    context.rect(px(col) + cell, py(row) + cell, cell * 5, cell * 5);
  context.fillStyle = background;
  context.fill();

  context.beginPath();
  for (const [row, col] of finders)
    context.rect(px(col) + cell * 2, py(row) + cell * 2, cell * 3, cell * 3);
  context.fillStyle = foreground;
  context.fill();

  context.restore();
}

/** Append a smooth Catmull-Rom spline through the given points to the path. */
function tracedSpline(context: CanvasRenderingContext2D, points: Array<[number, number]>) {
  if (points.length === 0) return;
  context.moveTo(points[0]![0], points[0]![1]);
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    context.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6,
      p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
      p2[0],
      p2[1]
    );
  }
}

function setLetterSpacing(context: CanvasRenderingContext2D, value: string) {
  const mutable = context as CanvasRenderingContext2D & { letterSpacing?: string };
  if ('letterSpacing' in mutable) mutable.letterSpacing = value;
}

/** A diagonal metallic gradient across the given box, for foil-stamped fills/strokes. */
function makeFoil(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  palette: string[],
  angle = -0.32
): CanvasGradient {
  const cx = x + width / 2;
  const cy = y + height / 2;
  const reach = Math.max(width, height) / 2;
  const dx = Math.cos(angle) * reach;
  const dy = Math.sin(angle) * reach;
  const gradient = context.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  palette.forEach((stop, index) => gradient.addColorStop(index / (palette.length - 1), stop));
  return gradient;
}

function foilPalette(cfg: UsageShareCardConfig): string[] | null {
  return cfg.foil === 'none' ? null : FOIL_PALETTES[cfg.foil];
}

/** A translucent diagonal highlight that sweeps across the card as `progress` advances. */
function drawSheen(
  context: CanvasRenderingContext2D,
  geo: CardGeometry,
  cfg: UsageShareCardConfig,
  progress: number
) {
  context.save();
  roundedRectPath(context, geo.left, geo.top, geo.width, geo.height, cfg.cornerRadius);
  context.clip();
  const position = 0.12 + 0.76 * easeOutCubic(progress);
  const cx = geo.left + geo.width * position;
  const band = geo.width * 0.16;
  const gradient = context.createLinearGradient(cx - band, geo.top, cx + band, geo.bottom);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.4)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(geo.left, geo.top, geo.width, geo.height);
  context.restore();
}

// --- Card layers ----------------------------------------------------------

type CardGeometry = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  tearPx: number;
  contentLeft: number;
  contentRight: number;
};

function computeGeometry(cfg: UsageShareCardConfig): CardGeometry {
  const left = cfg.marginX;
  const top = cfg.marginY;
  const right = cfg.width - cfg.marginX;
  const bottom = cfg.height - cfg.marginY;
  const width = right - left;
  const tearPx = cfg.showStub ? left + cfg.tearX * width : right;
  return {
    left,
    top,
    right,
    bottom,
    width,
    height: bottom - top,
    tearPx,
    contentLeft: left + cfg.contentPadX,
    contentRight: tearPx - cfg.contentPadX,
  };
}

function drawPaper(
  context: CanvasRenderingContext2D,
  cfg: UsageShareCardConfig,
  geo: CardGeometry
) {
  // Soft drop shadow under the whole ticket.
  context.save();
  context.shadowColor = `rgba(30,26,18,${cfg.shadowOpacity})`;
  context.shadowBlur = 34;
  context.shadowOffsetY = 16;
  roundedRectPath(context, geo.left, geo.top, geo.width, geo.height, cfg.cornerRadius);
  context.fillStyle = cfg.paperTop;
  context.fill();
  context.restore();

  // Paper gradient.
  roundedRectPath(context, geo.left, geo.top, geo.width, geo.height, cfg.cornerRadius);
  const gradient = context.createLinearGradient(0, geo.top, 0, geo.bottom);
  gradient.addColorStop(0, cfg.paperTop);
  gradient.addColorStop(1, cfg.paperBottom);
  context.fillStyle = gradient;
  context.fill();

  if (cfg.showGrain) {
    context.save();
    roundedRectPath(context, geo.left, geo.top, geo.width, geo.height, cfg.cornerRadius);
    context.clip();
    const random = mulberry32(0x9e3779b9);
    context.fillStyle = `rgba(60,52,36,${cfg.grainOpacity})`;
    const count = Math.round((geo.width * geo.height) / 1400);
    for (let i = 0; i < count; i += 1) {
      const gx = geo.left + random() * geo.width;
      const gy = geo.top + random() * geo.height;
      context.fillRect(gx, gy, 1, 1);
    }
    context.restore();
  }

  if (cfg.showFrame) {
    const inset = cfg.frameInset;
    roundedRectPath(
      context,
      geo.left + inset,
      geo.top + inset,
      geo.width - inset * 2,
      geo.height - inset * 2,
      Math.max(4, cfg.cornerRadius - inset)
    );
    context.strokeStyle = cfg.edgeColor;
    context.lineWidth = 1.5;
    context.stroke();
  }
}

function drawKicker(
  context: CanvasRenderingContext2D,
  cfg: UsageShareCardConfig,
  geo: CardGeometry
) {
  context.save();
  context.fillStyle = cfg.mutedInk;
  context.font = `600 15px ${cfg.fontSans}`;
  setLetterSpacing(context, '3px');
  context.fillText(cfg.kickerText.toUpperCase(), geo.contentLeft, cfg.kickerY);
  setLetterSpacing(context, '0px');
  context.restore();
}

function drawTitle(
  context: CanvasRenderingContext2D,
  cfg: UsageShareCardConfig,
  geo: CardGeometry,
  workspaceName: string
) {
  context.save();
  context.fillStyle = cfg.inkColor;
  context.font = `600 42px ${cfg.fontDisplay}`;
  const maxWidth = geo.contentRight - geo.contentLeft - (cfg.showMark ? cfg.markSize + 12 : 0);
  let label = workspaceName;
  while (label.length > 4 && context.measureText(label).width > maxWidth) {
    label = label.slice(0, -1);
  }
  if (label !== workspaceName) label = `${label.trimEnd()}…`;
  context.fillText(label, geo.contentLeft, cfg.titleY);
  context.restore();
}

/** Canvas-native VHS/CRT treatment for a line of text: RGB split + scanlines + a tape tear. */
function drawVhsText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  baselineY: number,
  size: number,
  width: number,
  progress: number
) {
  const top = baselineY - size;
  const boxHeight = size * 1.16;
  const aberration = 3.2 + Math.sin(progress * 34) * 1.6;
  const jitter = Math.sin(progress * 51) * 1.4;
  const bx = x + jitter;
  const boxLeft = x - aberration - 4;
  const boxWidth = width + aberration * 2 + 8;

  // RGB channel misalignment; multiply keeps the fringes legible on light paper.
  context.save();
  context.globalCompositeOperation = 'multiply';
  context.fillStyle = '#ff2b2b';
  context.fillText(text, bx - aberration, baselineY);
  context.fillStyle = '#12e8ff';
  context.fillText(text, bx + aberration, baselineY);
  context.globalAlpha = 0.85;
  context.fillStyle = '#1b1a24';
  context.fillText(text, bx, baselineY);
  context.restore();

  // Scanlines + a travelling tape-tear, clipped to the readout box.
  context.save();
  context.beginPath();
  context.rect(boxLeft, top - 4, boxWidth, boxHeight + 8);
  context.clip();
  context.fillStyle = 'rgba(255,255,255,0.42)';
  for (let ly = top; ly < top + boxHeight; ly += 3) {
    context.fillRect(boxLeft, ly, boxWidth, 1.3);
  }
  const tearY = top + ((progress * 2) % 1) * boxHeight;
  context.fillStyle = 'rgba(255,255,255,0.7)';
  context.fillRect(boxLeft, tearY, boxWidth, 2.4);
  context.restore();
}

function drawHero(
  context: CanvasRenderingContext2D,
  cfg: UsageShareCardConfig,
  geo: CardGeometry,
  model: UsageCalendarModel,
  insights: UsageShareCardInsights,
  subtitle: string,
  progress: number
) {
  const shown = model.totalValue * easeOutCubic(progress);
  const foil = foilPalette(cfg);
  context.save();
  context.font = `700 ${cfg.heroSize}px ${cfg.fontMono}`;
  const heroText = formatUsageCompact(shown);
  const heroWidth = context.measureText(heroText).width;
  if (cfg.heroFx === 'vhs') {
    drawVhsText(context, heroText, geo.contentLeft, cfg.heroY, cfg.heroSize, heroWidth, progress);
  } else {
    context.fillStyle = foil
      ? makeFoil(context, geo.contentLeft, cfg.heroY - cfg.heroSize, heroWidth, cfg.heroSize, foil)
      : cfg.inkColor;
    context.fillText(heroText, geo.contentLeft, cfg.heroY);
    if (foil) {
      context.lineWidth = 1;
      context.strokeStyle = 'rgba(120,128,140,0.35)';
      context.strokeText(heroText, geo.contentLeft, cfg.heroY);
    }
  }

  context.fillStyle = cfg.mutedInk;
  context.font = `600 20px ${cfg.fontSans}`;
  setLetterSpacing(context, '2px');
  context.fillText(cfg.unitLabel.toUpperCase(), geo.contentLeft + heroWidth + 16, cfg.heroY - 6);
  setLetterSpacing(context, '0px');

  // Trend delta chip.
  if (cfg.showTrendDelta && insights.trendDelta != null && progress > 0.55) {
    const up = insights.trendDelta >= 0;
    const chip = `${up ? '▲' : '▼'} ${Math.abs(Math.round(insights.trendDelta * 100))}%`;
    context.font = `700 18px ${cfg.fontSans}`;
    const chipWidth = context.measureText(chip).width + 26;
    const chipX = geo.contentLeft + heroWidth + 20;
    const chipY = cfg.heroY + 8;
    context.globalAlpha = easeOutCubic((progress - 0.55) / 0.45);
    context.fillStyle = up ? cfg.accent : '#c8623f';
    roundedRectPath(context, chipX, chipY, chipWidth, 30, 15);
    context.fill();
    context.fillStyle = '#ffffff';
    context.fillText(chip, chipX + 13, chipY + 21);
    context.globalAlpha = 1;
  }

  context.fillStyle = cfg.mutedInk;
  context.font = `400 16px ${cfg.fontSans}`;
  context.fillText(subtitle, geo.contentLeft, cfg.subtitleY);
  context.restore();
}

function drawTrend(
  context: CanvasRenderingContext2D,
  cfg: UsageShareCardConfig,
  geo: CardGeometry,
  insights: UsageShareCardInsights,
  progress: number
) {
  const totals = insights.weeklyTotals;
  const maxWeekly = Math.max(1, ...totals);
  const chartLeft = geo.contentLeft;
  const chartRight = geo.contentRight;
  const chartWidth = chartRight - chartLeft;
  const top = cfg.chartTop;
  const bottom = cfg.chartTop + cfg.chartHeight;

  const points: Array<[number, number]> = totals.map((value, index) => [
    chartLeft + (index / Math.max(1, totals.length - 1)) * chartWidth,
    bottom - (value / maxWeekly) * cfg.chartHeight,
  ]);
  if (points.length < 2) return;

  const eased = easeOutCubic(progress);
  const revealX = chartLeft + chartWidth * eased;
  const foil = foilPalette(cfg);
  const peakIndex = totals.reduce(
    (best, value, index) => (value > totals[best]! ? index : best),
    0
  );
  const [peakX, peakY] = points[peakIndex]!;

  context.save();

  // Faint dotted gridlines for a lightweight data-viz frame.
  context.strokeStyle = cfg.edgeColor;
  context.lineWidth = 1;
  context.globalAlpha = 0.7;
  context.setLineDash([2, 5]);
  for (const fraction of [0.33, 0.66, 1]) {
    const gy = bottom - cfg.chartHeight * fraction;
    context.beginPath();
    context.moveTo(chartLeft, gy);
    context.lineTo(chartRight, gy);
    context.stroke();
  }
  context.setLineDash([]);
  context.globalAlpha = 1;

  // Reveal clip grows left→right for the draw-on animation.
  context.save();
  context.beginPath();
  context.rect(chartLeft - 2, top - 48, revealX - chartLeft + 2, cfg.chartHeight + 96);
  context.clip();

  if (cfg.trendFill) {
    context.beginPath();
    tracedSpline(context, points);
    context.lineTo(points.at(-1)![0], bottom);
    context.lineTo(points[0]![0], bottom);
    context.closePath();
    const fill = context.createLinearGradient(0, top, 0, bottom);
    fill.addColorStop(0, `${cfg.accent}4d`);
    fill.addColorStop(0.55, `${cfg.accent}1c`);
    fill.addColorStop(1, `${cfg.accent}00`);
    context.fillStyle = fill;
    context.fill();
  }

  // The line, with a soft glow for a more polished look.
  context.beginPath();
  tracedSpline(context, points);
  context.strokeStyle = foil
    ? makeFoil(context, chartLeft, top, chartWidth, cfg.chartHeight, foil, 0.32)
    : cfg.accent;
  context.lineWidth = cfg.trendLineWidth;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.shadowColor = foil ? 'rgba(60,66,76,0.5)' : `${cfg.accent}66`;
  context.shadowBlur = foil ? 5 : 9;
  context.shadowOffsetY = foil ? 2 : 3;
  context.stroke();
  context.restore();

  // Peak marker: guide line + dot + value, revealed in sync with the draw-on.
  if (revealX >= peakX - 1) {
    context.save();
    context.globalAlpha = easeOutCubic(Math.min(1, (revealX - peakX) / 40 + 0.2));
    context.strokeStyle = cfg.edgeColor;
    context.lineWidth = 1;
    context.setLineDash([2, 4]);
    context.beginPath();
    context.moveTo(peakX, peakY + 4);
    context.lineTo(peakX, bottom);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = foil ? '#8b94a0' : cfg.accent;
    context.beginPath();
    context.arc(peakX, peakY, 4, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = cfg.mutedInk;
    context.font = `600 13px ${cfg.fontSans}`;
    context.textAlign = 'center';
    context.fillText(formatUsageCompact(totals[peakIndex]!), peakX, peakY - 12);
    context.textAlign = 'start';
    context.restore();
  }

  // Leading dot at the reveal front.
  const frontIndex = (points.length - 1) * eased;
  const lowIndex = Math.floor(frontIndex);
  const highIndex = Math.min(points.length - 1, lowIndex + 1);
  const frac = frontIndex - lowIndex;
  const dotX = points[lowIndex]![0] + (points[highIndex]![0] - points[lowIndex]![0]) * frac;
  const dotY = points[lowIndex]![1] + (points[highIndex]![1] - points[lowIndex]![1]) * frac;
  context.fillStyle = '#ffffff';
  context.strokeStyle = foil ? '#8b94a0' : cfg.accent;
  context.lineWidth = cfg.trendLineWidth;
  context.beginPath();
  context.arc(dotX, dotY, cfg.trendDotRadius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
}

function drawBars(
  context: CanvasRenderingContext2D,
  cfg: UsageShareCardConfig,
  geo: CardGeometry,
  insights: UsageShareCardInsights,
  progress: number
) {
  const totals = insights.weeklyTotals;
  const maxWeekly = Math.max(1, ...totals);
  const chartLeft = geo.contentLeft;
  const chartWidth = geo.contentRight - chartLeft;
  const bottom = cfg.chartTop + cfg.chartHeight;
  const gap = Math.max(1.5, chartWidth / totals.length / 4);
  const barWidth = (chartWidth - gap * (totals.length - 1)) / totals.length;
  const eased = easeOutCubic(progress);
  const foil = foilPalette(cfg);
  const barFill = foil
    ? makeFoil(context, chartLeft, cfg.chartTop, chartWidth, cfg.chartHeight, foil, 0.32)
    : cfg.accent;

  context.save();
  context.strokeStyle = cfg.edgeColor;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(chartLeft, bottom);
  context.lineTo(geo.contentRight, bottom);
  context.stroke();

  if (foil) {
    context.shadowColor = 'rgba(60,66,76,0.4)';
    context.shadowBlur = 4;
    context.shadowOffsetY = 1;
  }
  for (const [index, value] of totals.entries()) {
    const full = (value / maxWeekly) * cfg.chartHeight;
    const height = full * eased;
    if (height <= 0.5) continue;
    const x = chartLeft + index * (barWidth + gap);
    const alpha = 0.45 + 0.55 * (value / maxWeekly);
    context.globalAlpha = alpha;
    context.fillStyle = barFill;
    roundedRectPath(context, x, bottom - height, barWidth, height, Math.min(barWidth / 2, 3));
    context.fill();
  }
  context.restore();
}

function drawHeatmapHero(
  context: CanvasRenderingContext2D,
  cfg: UsageShareCardConfig,
  geo: CardGeometry,
  model: UsageCalendarModel,
  progress: number
) {
  const left = geo.contentLeft;
  const width = geo.contentRight - left;
  const gap = 4;
  const colStride = width / USAGE_CALENDAR_COLUMNS;
  const rowStride = cfg.chartHeight / USAGE_CALENDAR_ROWS;
  const size = Math.max(2, Math.min(colStride, rowStride) - gap);
  const reveal = easeOutCubic(progress) * USAGE_CALENDAR_COLUMNS;

  for (const cell of model.cells) {
    if (cell.isFuture || cell.column > reveal) continue;
    const x = left + cell.column * colStride;
    const y = cfg.chartTop + cell.row * rowStride;
    context.fillStyle = cell.level === 0 ? `${cfg.edgeColor}66` : HEATMAP_LEVEL_COLORS[cell.level]!;
    roundedRectPath(context, x, y, size, size, Math.min(3, size / 3));
    context.fill();
  }
}

function drawStats(
  context: CanvasRenderingContext2D,
  cfg: UsageShareCardConfig,
  geo: CardGeometry,
  model: UsageCalendarModel,
  insights: UsageShareCardInsights,
  labels: UsageShareCardLabels
) {
  const entries: Array<[string, string]> = [
    [labels.peakDay, formatUsageCompact(insights.peakCell?.value ?? 0)],
    [labels.dailyAverage, formatUsageCompact(insights.dailyAverage)],
    [labels.activeDays, String(model.activeDays)],
    [labels.longestStreak, `${model.longestStreak}d`],
  ];
  const left = geo.contentLeft;
  const cellWidth = (geo.contentRight - left) / entries.length;

  context.save();
  for (const [index, [label, value]] of entries.entries()) {
    const x = left + index * cellWidth;
    if (index > 0) {
      context.strokeStyle = cfg.edgeColor;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, cfg.statsY - 4);
      context.lineTo(x, cfg.statsY + 44);
      context.stroke();
    }
    context.fillStyle = cfg.mutedInk;
    context.font = `600 13px ${cfg.fontSans}`;
    setLetterSpacing(context, '1px');
    context.fillText(label.toUpperCase(), x + 14, cfg.statsY + 10);
    setLetterSpacing(context, '0px');
    context.fillStyle = cfg.inkColor;
    context.font = `700 26px ${cfg.fontMono}`;
    context.fillText(value, x + 14, cfg.statsY + 42);
  }
  context.restore();
}

function drawHeatmapStrip(
  context: CanvasRenderingContext2D,
  cfg: UsageShareCardConfig,
  geo: CardGeometry,
  model: UsageCalendarModel
) {
  const left = geo.contentLeft;
  const width = geo.contentRight - left;
  const gap = 3;
  const cell = (width - gap * (USAGE_CALENDAR_COLUMNS - 1)) / USAGE_CALENDAR_COLUMNS;
  const rowStride = cfg.heatmapHeight / USAGE_CALENDAR_ROWS;
  const size = Math.min(cell, rowStride - 1.2);
  for (const c of model.cells) {
    if (c.isFuture || c.level === 0) continue;
    const x = left + c.column * (cell + gap);
    const y = cfg.heatmapTop + c.row * rowStride;
    context.fillStyle = HEATMAP_LEVEL_COLORS[c.level]!;
    roundedRectPath(context, x, y, size, size, Math.min(2, size / 3));
    context.fill();
  }
}

function drawMark(
  context: CanvasRenderingContext2D,
  cfg: UsageShareCardConfig,
  geo: CardGeometry,
  progress: number
) {
  const markX = cfg.markX < 0 ? geo.tearPx + cfg.markX : geo.contentLeft + cfg.markX;
  const entrance = easeOutCubic(Math.max(0, Math.min(1, (progress - 0.16) / 0.58)));
  const bounce = 1 + Math.sin(entrance * Math.PI) * 0.12;
  drawLodyMark(context, markX, cfg.markY, cfg.markSize, {
    rotation: cfg.markFx === 'vhs' ? 0 : cfg.markRotation - (1 - entrance) * 14,
    opacity: cfg.markOpacity * entrance,
    style: cfg.markStyle,
    fill: cfg.markFill,
    stroke: cfg.markStroke,
    strokeWidth: cfg.markStrokeWidth,
    foil: cfg.markFx === 'vhs' ? null : foilPalette(cfg),
    fx: cfg.markFx,
    progress,
    sizeMultiplier: (0.62 + entrance * 0.38) * bounce,
  });
}

function drawStub(
  context: CanvasRenderingContext2D,
  cfg: UsageShareCardConfig,
  geo: CardGeometry,
  model: UsageCalendarModel
) {
  // Modern e-ticket stub: a small caption, a branded QR block, a serial, and a
  // slim barcode — all centred so the strip never reads as skewed. The QR is the
  // seed of the future social "scan / drag me in" token.
  const centerX = (geo.tearPx + geo.right) / 2;
  const stubWidth = geo.right - geo.tearPx;
  const serial =
    cfg.serial || `NO.${String(Math.round(model.totalValue) % 100000).padStart(5, '0')}`;

  if (cfg.showStubStamp) {
    const qrSize = Math.min(stubWidth - 34, 132);
    const qrX = centerX - qrSize / 2;
    const qrY = geo.top + geo.height * 0.26;

    context.save();
    context.fillStyle = cfg.mutedInk;
    context.font = `600 11px ${cfg.fontSans}`;
    context.textAlign = 'center';
    setLetterSpacing(context, '2px');
    context.fillText('SCAN · COMPARE', centerX, qrY - 16);
    setLetterSpacing(context, '0px');
    context.restore();

    // A soft quiet-zone panel so the code reads cleanly on textured paper.
    context.save();
    const pad = qrSize * 0.08;
    roundedRectPath(context, qrX - pad, qrY - pad, qrSize + pad * 2, qrSize + pad * 2, 12);
    context.fillStyle = '#ffffff';
    context.globalAlpha = 0.66;
    context.fill();
    context.globalAlpha = 1;
    context.strokeStyle = cfg.edgeColor;
    context.lineWidth = 1;
    context.stroke();
    context.restore();

    drawFauxQr(
      context,
      qrX,
      qrY,
      qrSize,
      (Math.round(model.totalValue) % 100000) + 7,
      cfg.inkColor,
      '#ffffff'
    );

    // Branded centre badge with the Lody mark (never glitched here).
    const badge = qrSize * 0.28;
    context.save();
    roundedRectPath(
      context,
      centerX - badge / 2,
      qrY + qrSize / 2 - badge / 2,
      badge,
      badge,
      badge * 0.3
    );
    context.fillStyle = cfg.paperTop;
    context.fill();
    context.restore();
    drawLodyMark(context, centerX, qrY + qrSize / 2, badge * 0.74, {
      style: 'plain',
      fill: cfg.accent,
      foil: foilPalette(cfg),
    });

    context.save();
    context.fillStyle = cfg.mutedInk;
    context.font = `500 14px ${cfg.fontMono}`;
    context.textAlign = 'center';
    context.fillText(serial, centerX, qrY + qrSize + 30);
    context.restore();
  }

  if (cfg.showBarcode) {
    const bars = [3, 1, 2, 4, 1, 3, 2, 1, 4, 2, 3, 1, 2, 4, 1, 3, 2, 1];
    const gap = 2;
    const barcodeY = geo.bottom - 44;
    const totalWidth = bars.reduce((sum, bar) => sum + (bar >= 3 ? 3 : 2) + gap, -gap);
    let bx = centerX - totalWidth / 2;
    context.fillStyle = cfg.inkColor;
    for (const bar of bars) {
      const width = bar >= 3 ? 3 : 2;
      context.fillRect(bx, barcodeY, width, 26);
      bx += width + gap;
    }
  }
}

function punchPerforations(
  context: CanvasRenderingContext2D,
  cfg: UsageShareCardConfig,
  geo: CardGeometry
) {
  context.save();
  context.globalCompositeOperation = 'destination-out';
  context.fillStyle = '#000';

  if (cfg.showStub) {
    // Tear-line holes.
    const startY = geo.top + cfg.tearInset;
    const endY = geo.bottom - cfg.tearInset;
    for (let y = startY; y <= endY; y += cfg.perfSpacing) {
      punchHole(context, geo.tearPx, y, cfg.perfRadius);
    }
    // Semicircle notches at both ends of the tear.
    punchHole(context, geo.tearPx, geo.top, cfg.notchRadius);
    punchHole(context, geo.tearPx, geo.bottom, cfg.notchRadius);
  }

  if (cfg.scallopEdge) {
    const inset = cfg.cornerRadius;
    for (let x = geo.left + inset; x <= geo.right - inset; x += cfg.scallopSpacing) {
      punchHole(context, x, geo.top, cfg.scallopRadius);
      punchHole(context, x, geo.bottom, cfg.scallopRadius);
    }
    for (let y = geo.top + inset; y <= geo.bottom - inset; y += cfg.scallopSpacing) {
      punchHole(context, geo.left, y, cfg.scallopRadius);
      punchHole(context, geo.right, y, cfg.scallopRadius);
    }
  }
  context.restore();
}

export type UsageShareCardLabels = {
  peakDay: string;
  dailyAverage: string;
  activeDays: string;
  longestStreak: string;
  stubLabel: string;
};

export const DEFAULT_USAGE_SHARE_CARD_LABELS: UsageShareCardLabels = {
  peakDay: 'Peak day',
  dailyAverage: 'Daily avg',
  activeDays: 'Active days',
  longestStreak: 'Longest',
  stubLabel: 'Lody Usage',
};

export type UsageShareCardFrameInput = {
  model: UsageCalendarModel;
  workspaceName: string;
  subtitle: string;
  style?: UsageShareCardStyle;
  config?: Partial<UsageShareCardConfig>;
  labels?: Partial<UsageShareCardLabels>;
};

/**
 * Draw one frame of the usage share card into an existing 2D context. `progress`
 * in [0, 1] drives the reveal animation (count-up, trend draw-on, sticker pop, chip fade);
 * pass 1 for the final static frame used by PNG export.
 */
export function renderUsageShareCardFrame(
  context: CanvasRenderingContext2D,
  input: UsageShareCardFrameInput,
  progress = 1
): void {
  const cfg = resolveShareCardConfig(input.config);
  const labels = { ...DEFAULT_USAGE_SHARE_CARD_LABELS, ...(input.labels ?? {}) };
  const geo = computeGeometry(cfg);
  const insights = computeUsageShareInsights(input.model);

  context.clearRect(0, 0, cfg.width, cfg.height);
  drawPaper(context, cfg, geo);

  // Clip the busy content to the main body so nothing bleeds into the stub.
  context.save();
  roundedRectPath(context, geo.left, geo.top, geo.width, geo.height, cfg.cornerRadius);
  context.clip();

  context.save();
  context.beginPath();
  context.rect(geo.left, geo.top, geo.tearPx - geo.left, geo.height);
  context.clip();
  drawKicker(context, cfg, geo);
  drawTitle(context, cfg, geo, input.workspaceName);
  drawHero(context, cfg, geo, input.model, insights, input.subtitle, progress);
  if (cfg.showTrend) {
    if (cfg.heroGraphic === 'heatmap') drawHeatmapHero(context, cfg, geo, input.model, progress);
    else if (cfg.heroGraphic === 'bars') drawBars(context, cfg, geo, insights, progress);
    else drawTrend(context, cfg, geo, insights, progress);
  }
  if (cfg.showStats) drawStats(context, cfg, geo, input.model, insights, labels);
  if (cfg.showHeatmap) drawHeatmapStrip(context, cfg, geo, input.model);
  context.restore();

  if (cfg.showStub) drawStub(context, cfg, geo, input.model);
  if (cfg.showMark) drawMark(context, cfg, geo, progress);
  if (cfg.foil !== 'none') drawSheen(context, geo, cfg, progress);
  context.restore();

  punchPerforations(context, cfg, geo);
}

function createShareCanvas(cfg: UsageShareCardConfig): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const scale = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  const canvas = document.createElement('canvas');
  canvas.width = cfg.width * scale;
  canvas.height = cfg.height * scale;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is unavailable');
  context.scale(scale, scale);
  return { canvas, context };
}

/**
 * Render the final (static) usage share card to a PNG blob.
 *
 * `style` picks the subtitle wording and is kept for backward compatibility with
 * the earlier flat/isometric switch; the optional `config` override is where the
 * Storybook-tuned values are plugged in.
 */
export async function createUsageShareCard(
  model: UsageCalendarModel,
  workspaceName: string,
  totalLabel: string,
  style: UsageShareCardStyle = 'isometric',
  config?: Partial<UsageShareCardConfig>
): Promise<Blob> {
  await waitForUsageShareCardFonts();
  const cfg = resolveShareCardConfig(config);
  const { canvas, context } = createShareCanvas(cfg);
  const subtitle =
    totalLabel ||
    (style === 'flat' ? 'Usage heatmap · last 53 weeks' : 'Usage skyline · last 53 weeks');
  renderUsageShareCardFrame(context, { model, workspaceName, subtitle, style, config }, 1);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not create share card'))),
      'image/png'
    );
  });
}

export type UsageShareCardPreset = {
  label: string;
  description: string;
  config: Partial<UsageShareCardConfig>;
};

/**
 * Ready-made combinations across the three axes (shape × theme × hero graphic).
 * Each is just a config override, so they compose with anything tuned in Storybook.
 */
export const USAGE_SHARE_CARD_PRESETS: Record<string, UsageShareCardPreset> = {
  ticket: {
    label: 'Cinema ticket',
    description: 'Warm paper, tear-off stub, trend curve.',
    config: {
      foil: 'champagne',
      paperTop: '#ffffff',
      paperBottom: '#f4ebda',
      edgeColor: '#dbcfb2',
      inkColor: '#1e1717',
      mutedInk: '#948d7b',
      accent: '#2a5bbb',
      markStroke: '#f7f3ea',
      trendFill: true,
      showHeatmap: true,
    },
  },
  stamp: {
    label: 'Postage stamp',
    description: 'Scalloped die-cut edge, no stub, curve fills the frame.',
    config: { scallopEdge: true, showStub: false, cornerRadius: 16, markRotation: -6 },
  },
  kraft: {
    label: 'Kraft receipt',
    description: 'Recycled-paper browns with a rust accent.',
    config: {
      paperTop: '#e8dab6',
      paperBottom: '#dcc99f',
      edgeColor: '#c7b085',
      inkColor: '#3a2e1b',
      mutedInk: '#8a7857',
      accent: '#b5622d',
      accentSoft: '#e0a877',
      markFill: '#3a2e1b',
      markStroke: '#e8dab6',
    },
  },
  silverFoil: {
    label: 'Silver foil',
    description: '珍珠白卡面 + 银箔烫印（数字/曲线/贴纸），带扫光。现在是默认。',
    config: {},
  },
  platinumFoil: {
    label: 'Platinum foil · bars',
    description: '冷调铂金烫印，柱状主视觉。',
    config: {
      foil: 'platinum',
      heroGraphic: 'bars',
      paperTop: '#eef1f5',
      paperBottom: '#e0e5ec',
      edgeColor: '#c4ccd6',
      inkColor: '#353b44',
      mutedInk: '#8f98a4',
      accent: '#7f8896',
      markStroke: '#ffffff',
      showHeatmap: false,
    },
  },
  champagneFoil: {
    label: 'Champagne foil',
    description: '暖调香槟金烫印，浅色不刺眼。',
    config: {
      foil: 'champagne',
      paperTop: '#fbf6ea',
      paperBottom: '#f3ead4',
      edgeColor: '#e3d4ae',
      inkColor: '#4a4130',
      mutedInk: '#a99a76',
      accent: '#c6a55c',
      markStroke: '#fffdf7',
      trendFill: false,
      showHeatmap: false,
    },
  },
  vhs: {
    label: 'VHS readout',
    description: '数字用 CRT/VHS 特效（RGB 错位 + 扫描线 + 抖动），复古终端字。',
    config: {
      heroFx: 'vhs',
      fontMono: '"VT323", "JetBrains Mono", ui-monospace, monospace',
      fontDisplay: '"Bebas Neue", "Arial Narrow", sans-serif',
      heroSize: 100,
      heroY: 248,
      subtitleY: 274,
    },
  },
  contribution: {
    label: 'Contribution wall',
    description: 'The GitHub-style heatmap as the hero graphic.',
    config: { heroGraphic: 'heatmap', showHeatmap: false, chartHeight: 150, chartTop: 296 },
  },
  minimal: {
    label: 'Minimal card',
    description: 'No stub, no frame, soft rounded corners.',
    config: {
      showStub: false,
      showFrame: false,
      showStubStamp: false,
      cornerRadius: 44,
      scallopEdge: false,
      markX: -108,
    },
  },
};
