import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { createUsageCalendarModel } from '@/components/settings/usage-calendar-model';
import {
  DEFAULT_USAGE_SHARE_CARD_CONFIG,
  renderUsageShareCardFrame,
  createUsageShareCard,
  USAGE_SHARE_CARD_PRESETS,
  type UsageShareCardConfig,
  type UsageShareCardStyle,
} from '@/components/settings/usage-share-card';
import { preloadUsageShareCardFonts } from '@/components/settings/usage-share-card-fonts';
import { exportUsageShareCardVideo } from '@/components/settings/usage-share-card-export';

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2025, 6, 20);

function wave(index: number, intensity: number): number {
  const primary = Math.sin(index * 0.43) * 0.5 + 0.5;
  const secondary = Math.sin(index * 0.11 + 1.3) * 0.5 + 0.5;
  const ramp = 0.35 + 0.65 * (index / 364);
  return primary * secondary * ramp * intensity;
}

function buildModel(empty: boolean, intensity: number) {
  return createUsageCalendarModel({
    startMs: START_MS,
    endMs: START_MS + 370 * DAY_MS,
    days: Array.from({ length: 371 }, (_, index) => {
      const dayStartMs = START_MS + index * DAY_MS;
      const activity = empty || index > 364 ? 0 : Math.round(wave(index, intensity) * 180_000);
      return {
        dayStartMs,
        date: new Date(dayStartMs).toISOString().slice(0, 10),
        tokens: index % 9 === 0 ? 0 : activity,
        costUSD: activity * 0.000012,
        isFuture: index > 364,
      };
    }),
  });
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

// --- Webfont loading (Storybook preview only) -----------------------------

const FONT_LINK_ID = 'lody-share-card-fonts';
const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@600;700&family=Bebas+Neue&family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600;700&family=Instrument+Serif&family=JetBrains+Mono:wght@500;700&family=Monoton&family=Orbitron:wght@600;800&family=Space+Mono:wght@400;700&family=VT323&display=swap';

// Title / display faces, including a few artistic ones.
const FONT_OPTIONS = [
  '"Bitcount Grid Double", "Bricolage Grotesque", sans-serif',
  '"Bricolage Grotesque", "Inter", sans-serif',
  '"Fraunces", Georgia, serif',
  '"Instrument Serif", Georgia, serif',
  '"Anton", "Arial Narrow", sans-serif',
  '"Bebas Neue", "Arial Narrow", sans-serif',
  '"Monoton", cursive',
  '"Orbitron", sans-serif',
  '"Archivo", "Inter", sans-serif',
  'Inter, sans-serif',
];

// Numeric / mono faces for the hero readout.
const FONT_MONO_OPTIONS = [
  '"JetBrains Mono", ui-monospace, monospace',
  '"VT323", "JetBrains Mono", monospace',
  '"Orbitron", sans-serif',
  '"Space Mono", monospace',
];

function ensureFonts() {
  if (typeof document === 'undefined' || document.getElementById(FONT_LINK_ID)) return;
  const link = document.createElement('link');
  link.id = FONT_LINK_ID;
  link.rel = 'stylesheet';
  link.href = FONT_HREF;
  document.head.appendChild(link);
}

function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    ensureFonts();
    let cancelled = false;
    const probes = [
      '600 42px "Bricolage Grotesque"',
      '600 42px "Fraunces"',
      '400 42px "Instrument Serif"',
      '400 42px "Anton"',
      '400 42px "Bebas Neue"',
      '400 42px "Monoton"',
      '800 42px "Orbitron"',
      '700 82px "JetBrains Mono"',
      '400 82px "VT323"',
      '700 42px "Space Mono"',
      '600 15px "Inter"',
    ];
    const fonts = (document as unknown as { fonts?: FontFaceSet }).fonts;
    if (!fonts) {
      setReady(true);
    } else {
      void Promise.all([
        preloadUsageShareCardFonts(),
        ...probes.map((probe) => fonts.load(probe).catch(() => undefined)),
      ])
        .then(() => fonts.ready)
        .then(() => {
          if (!cancelled) setReady(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);
  return ready;
}

const CONFIG_KEYS = Object.keys(DEFAULT_USAGE_SHARE_CARD_CONFIG) as Array<keyof UsageShareCardConfig>;

type PlaygroundArgs = UsageShareCardConfig & {
  workspaceName: string;
  subtitle: string;
  style: UsageShareCardStyle;
  intensity: number;
  empty: boolean;
};

function pickConfig(args: PlaygroundArgs): UsageShareCardConfig {
  const config = {} as UsageShareCardConfig;
  for (const key of CONFIG_KEYS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any)[key] = args[key];
  }
  return config;
}

function configDelta(config: UsageShareCardConfig): Partial<UsageShareCardConfig> {
  const delta: Partial<UsageShareCardConfig> = {};
  for (const key of CONFIG_KEYS) {
    if (config[key] !== DEFAULT_USAGE_SHARE_CARD_CONFIG[key]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (delta as any)[key] = config[key];
    }
  }
  return delta;
}

function Playground(args: PlaygroundArgs) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const [status, setStatus] = useState<string>('');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  const fontsReady = useFontsReady();
  const config = useMemo(() => pickConfig(args), [args]);
  const model = useMemo(() => buildModel(args.empty, args.intensity), [args.empty, args.intensity]);
  const delta = useMemo(() => configDelta(config), [config]);

  const frameInput = useMemo(
    () => ({
      model,
      workspaceName: args.workspaceName,
      subtitle: args.subtitle,
      style: args.style,
      config,
    }),
    [args.style, args.subtitle, args.workspaceName, config, model]
  );

  const paint = useCallback(
    (progress: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== config.width * dpr) canvas.width = config.width * dpr;
      if (canvas.height !== config.height * dpr) canvas.height = config.height * dpr;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderUsageShareCardFrame(context, frameInput, progress);
    },
    [config.height, config.width, frameInput]
  );

  useEffect(() => {
    paint(1);
  }, [paint, fontsReady]);

  const play = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const start = performance.now();
    const duration = 2600;
    const tick = () => {
      const elapsed = performance.now() - start;
      const progress = Math.min(1, elapsed / (duration * 0.82));
      paint(progress);
      if (elapsed < duration) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [paint]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const copyConfig = useCallback(async () => {
    const text = JSON.stringify(delta, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setStatus('已复制 config delta 到剪贴板 — 贴回给我即可锁定');
    } catch {
      setStatus('复制失败，请从下方 JSON 手动复制');
    }
  }, [delta]);

  const downloadPng = useCallback(async () => {
    const blob = await createUsageShareCard(
      model,
      args.workspaceName,
      args.subtitle,
      args.style,
      config
    );
    downloadBlob(blob, 'lody-usage-card.png');
  }, [args.style, args.subtitle, args.workspaceName, config, model]);

  const exportVideo = useCallback(async () => {
    setStatus('正在编码 MP4…');
    setVideoUrl(null);
    try {
      const result = await exportUsageShareCardVideo(frameInput, {
        onProgress: (fraction) => setStatus(`正在编码 ${result_pct(fraction)}…`),
      });
      const url = URL.createObjectURL(result.blob);
      setVideoUrl(url);
      downloadBlob(result.blob, `lody-usage-card.${result.extension}`);
      setStatus(`已导出 ${result.extension.toUpperCase()} (${Math.round(result.blob.size / 1024)} KB)`);
    } catch (error) {
      setStatus(`导出失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [frameInput]);

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: 24, fontFamily: 'Inter, sans-serif' }}>
      <div
        style={{
          borderRadius: 16,
          background:
            'repeating-conic-gradient(#e9e9ec 0% 25%, #f4f4f6 0% 50%) 50% / 24px 24px',
          padding: 24,
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            height: 'auto',
            display: 'block',
            filter: 'drop-shadow(0 10px 30px rgba(0,0,0,0.18))',
          }}
        />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
        <button type="button" onClick={play} style={buttonStyle}>
          ▶ 播放动效
        </button>
        <button type="button" onClick={() => void downloadPng()} style={buttonStyle}>
          ⬇ 下载 PNG
        </button>
        <button type="button" onClick={() => void exportVideo()} style={buttonStyle}>
          🎬 导出 MP4
        </button>
        <button type="button" onClick={() => void copyConfig()} style={primaryButtonStyle}>
          📋 复制 config
        </button>
      </div>

      {status ? (
        <p style={{ marginTop: 12, fontSize: 13, color: '#555' }}>{status}</p>
      ) : null}

      {videoUrl ? (
        <video
          src={videoUrl}
          controls
          autoPlay
          loop
          style={{ width: '100%', marginTop: 16, borderRadius: 12 }}
        />
      ) : null}

      <p style={{ marginTop: 16, fontSize: 12, color: '#777' }}>
        改好后点「复制 config」，把下面这段贴回对话，我会把它设为新默认：
      </p>
      <pre
        style={{
          marginTop: 8,
          padding: 12,
          borderRadius: 8,
          background: '#0d1117',
          color: '#c9d1d9',
          fontSize: 12,
          overflowX: 'auto',
        }}
      >
        {JSON.stringify(delta, null, 2)}
      </pre>
    </div>
  );
}

function result_pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

const buttonStyle: CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #d0d0d5',
  background: '#fff',
  fontSize: 13,
  cursor: 'pointer',
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: '#2f9e57',
  borderColor: '#2f9e57',
  color: '#fff',
  fontWeight: 600,
};

const range = (min: number, max: number, step = 1) => ({
  control: { type: 'range' as const, min, max, step },
});
const color = { control: { type: 'color' as const } };

const meta: Meta<typeof Playground> = {
  title: 'Settings/UsageShareCard',
  component: Playground,
  parameters: { layout: 'fullscreen' },
  args: {
    ...DEFAULT_USAGE_SHARE_CARD_CONFIG,
    workspaceName: 'Acme Robotics',
    subtitle: 'Tokens · last 53 weeks',
    style: 'isometric',
    intensity: 1,
    empty: false,
  },
  argTypes: {
    // Content
    workspaceName: { control: 'text' },
    subtitle: { control: 'text' },
    kickerText: { control: 'text' },
    unitLabel: { control: 'text' },
    serial: { control: 'text' },
    style: { control: 'inline-radio', options: ['flat', 'isometric'] },
    foil: {
      control: 'inline-radio',
      options: ['none', 'silver', 'platinum', 'champagne'],
    },
    fontDisplay: { control: 'select', options: FONT_OPTIONS },
    intensity: range(0.2, 1.6, 0.05),
    empty: { control: 'boolean' },
    // Shape / die-cut
    cornerRadius: range(0, 60),
    tearX: range(0.4, 0.95, 0.01),
    tearInset: range(0, 60),
    perfRadius: range(1, 10, 0.5),
    perfSpacing: range(10, 40),
    notchRadius: range(0, 50),
    scallopEdge: { control: 'boolean' },
    scallopRadius: range(3, 18, 0.5),
    scallopSpacing: range(12, 50),
    marginX: range(10, 100),
    marginY: range(10, 100),
    frameInset: range(0, 40),
    showFrame: { control: 'boolean' },
    // Palette
    paperTop: color,
    paperBottom: color,
    edgeColor: color,
    inkColor: color,
    mutedInk: color,
    accent: color,
    accentSoft: color,
    showGrain: { control: 'boolean' },
    grainOpacity: range(0, 0.2, 0.005),
    shadowOpacity: range(0, 0.5, 0.01),
    // Hero + trend
    kickerY: range(50, 140),
    titleY: range(90, 200),
    heroY: range(150, 320),
    heroSize: range(48, 120),
    subtitleY: range(180, 340),
    showTrend: { control: 'boolean' },
    heroGraphic: { control: 'inline-radio', options: ['trend', 'heatmap', 'bars'] },
    chartTop: range(200, 400),
    chartHeight: range(60, 260),
    trendLineWidth: range(1, 10, 0.5),
    trendDotRadius: range(0, 14, 0.5),
    trendFill: { control: 'boolean' },
    showTrendDelta: { control: 'boolean' },
    // Stats + heatmap
    showStats: { control: 'boolean' },
    statsY: range(380, 560),
    showHeatmap: { control: 'boolean' },
    heatmapTop: range(440, 600),
    heatmapHeight: range(20, 90),
    // Lody sticker
    showMark: { control: 'boolean' },
    markStyle: { control: 'inline-radio', options: ['sticker', 'outline', 'plain'] },
    markFx: { control: 'inline-radio', options: ['none', 'vhs'] },
    markX: range(-260, 320),
    markY: range(40, 300),
    markSize: range(30, 180),
    markRotation: range(-45, 45),
    markOpacity: range(0, 1, 0.05),
    markFill: color,
    markStroke: color,
    markStrokeWidth: range(0, 24, 0.5),
    // Stub
    showStub: { control: 'boolean' },
    showStubStamp: { control: 'boolean' },
    stubStampSize: range(40, 200),
    showBarcode: { control: 'boolean' },
    contentPadX: range(16, 100),
    fontSans: { control: 'text' },
    fontMono: { control: 'select', options: FONT_MONO_OPTIONS },
    heroFx: { control: 'inline-radio', options: ['none', 'vhs'] },
    width: { table: { disable: true } },
    height: { table: { disable: true } },
  },
};
export default meta;

type Story = StoryObj<typeof Playground>;

export const Playground_: Story = { name: 'Playground' };

export const StampEdge: Story = {
  name: 'Stamp edge',
  args: { scallopEdge: true, showStub: false, cornerRadius: 18, markRotation: -6 },
};

export const Empty: Story = { args: { empty: true } };

// --- Preset gallery -------------------------------------------------------

function PresetCard({ presetKey }: { presetKey: keyof typeof USAGE_SHARE_CARD_PRESETS }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const preset = USAGE_SHARE_CARD_PRESETS[presetKey];
  const model = useMemo(() => buildModel(false, 1), []);
  const fontsReady = useFontsReady();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const config = { ...DEFAULT_USAGE_SHARE_CARD_CONFIG, ...preset.config };
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = config.width * dpr;
    canvas.height = config.height * dpr;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderUsageShareCardFrame(
      context,
      { model, workspaceName: 'Acme Robotics', subtitle: 'Tokens · last 53 weeks', config },
      1
    );
  }, [model, preset.config, fontsReady]);

  return (
    <figure style={{ margin: 0 }}>
      <div
        style={{
          borderRadius: 14,
          background: 'repeating-conic-gradient(#e9e9ec 0% 25%, #f4f4f6 0% 50%) 50% / 20px 20px',
          padding: 16,
        }}
      >
        <canvas ref={canvasRef} style={{ width: '100%', height: 'auto', display: 'block' }} />
      </div>
      <figcaption style={{ marginTop: 8, fontFamily: 'Inter, sans-serif' }}>
        <strong style={{ fontSize: 14 }}>{preset.label}</strong>
        <span style={{ fontSize: 12, color: '#777' }}> — {preset.description}</span>
        <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>preset: {presetKey}</div>
      </figcaption>
    </figure>
  );
}

function Gallery() {
  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#555' }}>
        三个可组合的轴：<strong>外形</strong>(票根 / 邮票 / 无) ×
        <strong>主题配色</strong> × <strong>主视觉图</strong>(趋势曲线 / 柱状 /
        贡献热力墙)。下面是几个现成组合，喜欢哪个告诉我 preset 名即可，或者去 Playground 微调后
        「复制 config」。
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 16 }}>
        {(Object.keys(USAGE_SHARE_CARD_PRESETS) as Array<keyof typeof USAGE_SHARE_CARD_PRESETS>).map(
          (key) => (
            <PresetCard key={key} presetKey={key} />
          )
        )}
      </div>
    </div>
  );
}

export const PresetGallery: StoryObj<typeof Gallery> = {
  name: 'Preset gallery',
  render: () => <Gallery />,
};

export const SilverFoil: Story = {
  name: 'Silver foil',
  args: USAGE_SHARE_CARD_PRESETS.silverFoil!.config,
};
export const PlatinumFoil: Story = {
  name: 'Platinum foil',
  args: USAGE_SHARE_CARD_PRESETS.platinumFoil!.config,
};
export const ChampagneFoil: Story = {
  name: 'Champagne foil',
  args: USAGE_SHARE_CARD_PRESETS.champagneFoil!.config,
};
export const Kraft: Story = { args: USAGE_SHARE_CARD_PRESETS.kraft!.config };
export const ContributionWall: Story = {
  name: 'Contribution wall',
  args: USAGE_SHARE_CARD_PRESETS.contribution!.config,
};
export const Bars: Story = { args: { heroGraphic: 'bars' } };
export const VhsReadout: Story = { name: 'VHS readout', args: USAGE_SHARE_CARD_PRESETS.vhs!.config };
