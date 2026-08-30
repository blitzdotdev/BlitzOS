import { useCallback, useMemo, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { AnimatePresence, motion, type PanInfo } from 'framer-motion';
import {
  createUsageCalendarModel,
  type UsageCalendarModel,
} from '@/components/settings/usage-calendar-model';
import {
  computeUsageShareInsights,
  formatUsageCompact,
  renderUsageShareCardFrame,
  resolveShareCardConfig,
  type UsageShareCardConfig,
} from '@/components/settings/usage-share-card';
import { TicketCutShaderView } from '@/components/settings/ticket-cut-shader';

// --- Fixtures --------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2025, 6, 20);

function buildModel(seedPhase: number, intensity: number): UsageCalendarModel {
  return createUsageCalendarModel({
    startMs: START_MS,
    endMs: START_MS + 370 * DAY_MS,
    days: Array.from({ length: 371 }, (_, index) => {
      const primary = Math.sin(index * 0.43 + seedPhase) * 0.5 + 0.5;
      const secondary = Math.sin(index * 0.11 + 1.3 + seedPhase) * 0.5 + 0.5;
      const ramp = 0.35 + 0.65 * (index / 364);
      const activity = index > 364 ? 0 : Math.round(primary * secondary * ramp * intensity * 180_000);
      return {
        dayStartMs: START_MS + index * DAY_MS,
        date: new Date(START_MS + index * DAY_MS).toISOString().slice(0, 10),
        tokens: index % 9 === 0 ? 0 : activity,
        costUSD: activity * 0.000012,
        isFuture: index > 364,
      };
    }),
  });
}

// --- Ticket rendering ------------------------------------------------------

const RENDER_SCALE = 2;

function renderBaseCanvas(
  model: UsageCalendarModel,
  name: string,
  config: Partial<UsageShareCardConfig>
): HTMLCanvasElement {
  const c = resolveShareCardConfig(config);
  const canvas = document.createElement('canvas');
  canvas.width = c.width * RENDER_SCALE;
  canvas.height = c.height * RENDER_SCALE;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.scale(RENDER_SCALE, RENDER_SCALE);
    renderUsageShareCardFrame(ctx, { model, workspaceName: name, subtitle: 'Tokens · last 53 weeks', config });
  }
  return canvas;
}

function renderTicketUrl(model: UsageCalendarModel, name: string, config: Partial<UsageShareCardConfig>): string {
  return renderBaseCanvas(model, name, config).toDataURL('image/png');
}

/** Re-render the ticket as if a validator chewed it: stub torn off (frayed edge),
 *  a punched hole, and a red "割 · VALIDATED" stamp overprinted. */
function renderCutTicketUrl(model: UsageCalendarModel, name: string, config: Partial<UsageShareCardConfig>): string {
  const base = renderBaseCanvas(model, name, config);
  const c = resolveShareCardConfig(config);
  const W = c.width;
  const H = c.height;
  const out = document.createElement('canvas');
  out.width = W * RENDER_SCALE;
  out.height = H * RENDER_SCALE;
  const ctx = out.getContext('2d');
  if (!ctx) return base.toDataURL('image/png');
  ctx.scale(RENDER_SCALE, RENDER_SCALE);

  const tearX = c.marginX + c.tearX * (W - c.marginX * 2);

  // Deterministic ragged tear profile, so the rip looks fibrous rather than zig-zag.
  const step = 9;
  const rand = (() => {
    let s = 0x9e3779b9;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();
  const tearPts: Array<[number, number]> = [];
  for (let y = 0; y <= H + step; y += step) {
    tearPts.push([tearX + (rand() * 16 - 6), Math.min(y, H)]);
  }

  // Clip to the main body with the frayed vertical tear on the right.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(tearPts[0]![0], 0);
  for (const [tx, ty] of tearPts) ctx.lineTo(tx, ty);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(base, 0, 0, base.width, base.height, 0, 0, W, H);

  // Shade the torn edge so it reads as a physical rip (dark core + paper-white fibre).
  ctx.strokeStyle = 'rgba(110,100,78,0.55)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(tearPts[0]![0], 0);
  for (const [tx, ty] of tearPts) ctx.lineTo(tx, ty);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(tearPts[0]![0] - 2.5, 0);
  for (const [tx, ty] of tearPts) ctx.lineTo(tx - 2.5, ty);
  ctx.stroke();
  ctx.restore();

  // Punched hole near the top-left.
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(c.marginX + 34, c.marginY + 34, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Validation stamp — parked over the quiet lower-right of the chart so it never
  // covers the workspace name or the hero number.
  ctx.save();
  ctx.translate(tearX * 0.8, H * 0.63);
  ctx.rotate(-0.21);
  ctx.globalAlpha = 0.78;
  ctx.strokeStyle = '#c0392b';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(0, 0, 84, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([4, 5]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 72, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#c0392b';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 62px "Noto Sans SC", "PingFang SC", system-ui, sans-serif';
  ctx.fillText('割', 0, -12);
  ctx.font = '700 15px Inter, sans-serif';
  ctx.fillText('VALIDATED', 0, 40);
  ctx.restore();

  return out.toDataURL('image/png');
}

const RIVAL_THEMES: Array<{ name: string; phase: number; intensity: number; config: Partial<UsageShareCardConfig> }> = [
  { name: 'Neo Studio', phase: 2.1, intensity: 1.35, config: {} },
  { name: 'Pixel Foundry', phase: 4.7, intensity: 0.7, config: { fontDisplay: '"Bebas Neue", sans-serif' } },
  { name: 'Umbra Labs', phase: 0.6, intensity: 1.05, config: {} },
];

type Ticket = {
  id: string;
  name: string;
  model: UsageCalendarModel;
  config: Partial<UsageShareCardConfig>;
  url: string;
  cutUrl: string;
};

// --- Layout constants ------------------------------------------------------

type Phase = 'idle' | 'feeding' | 'processing' | 'ejecting' | 'result';

const TICKET_W = 400;
const TICKET_H = (TICKET_W * 630) / 1200;
const MACHINE_W = TICKET_W + 72;
const FACE_H = 258;

// --- PK bits ---------------------------------------------------------------

function Bar({ value, color, label, strong }: { value: number; color: string; label: string; strong: boolean }) {
  return (
    <div style={{ position: 'relative', height: 20, background: '#efeadd', borderRadius: 6, overflow: 'hidden' }}>
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${Math.max(6, value * 100)}%` }}
        transition={{ duration: 0.7, delay: 0.15 }}
        style={{ position: 'absolute', inset: 0, background: color, borderRadius: 6 }}
      />
      <span style={{ position: 'absolute', left: 8, top: 0, lineHeight: '20px', fontSize: 12, fontWeight: strong ? 700 : 500, color: '#26251f' }}>{label}</span>
    </div>
  );
}

function Stat({ label, mine, theirs, format }: { label: string; mine: number; theirs: number; format: (v: number) => string }) {
  const max = Math.max(mine, theirs, 1);
  const youWins = mine >= theirs;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr', gap: 10, alignItems: 'center', marginTop: 10 }}>
      <span style={{ fontSize: 12, color: '#8a8577', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</span>
      <div style={{ display: 'grid', gap: 4 }}>
        <Bar value={mine / max} color={youWins ? '#2f9e57' : '#c9c4b4'} label={`你 ${format(mine)}`} strong={youWins} />
        <Bar value={theirs / max} color={!youWins ? '#2f9e57' : '#c9c4b4'} label={`对手 ${format(theirs)}`} strong={!youWins} />
      </div>
    </div>
  );
}

// --- Machine internals (the "processing" theatre) --------------------------

function Cog({ size, reverse }: { size: number; reverse?: boolean }) {
  const teeth = Array.from({ length: 8 }, (_, i) => i);
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      animate={{ rotate: reverse ? -360 : 360 }}
      transition={{ repeat: Infinity, duration: 1.6, ease: 'linear' }}
    >
      <g fill="#59636e">
        {teeth.map((t) => (
          <rect key={t} x={18.5} y={1} width={3} height={7} rx={1} transform={`rotate(${t * 45} 20 20)`} />
        ))}
        <circle cx={20} cy={20} r={13} />
        <circle cx={20} cy={20} r={4.5} fill="#2b3037" />
      </g>
    </motion.svg>
  );
}

/** Machine chrome layered over the shader view — must never hide the cut itself. */
function ProcessingTheatre() {
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 8, pointerEvents: 'none' }}>
      {/* interior vignette so the ticket reads as lit from inside the housing */}
      <div style={{ position: 'absolute', inset: 0, boxShadow: 'inset 0 0 46px rgba(0,0,0,0.75)' }} />
      {/* mechanism, kept in the corners */}
      <div style={{ position: 'absolute', left: 12, bottom: 8, opacity: 0.85 }}><Cog size={30} /></div>
      <div style={{ position: 'absolute', left: 35, bottom: 15, opacity: 0.85 }}><Cog size={21} reverse /></div>
      {/* LED progress */}
      <div style={{ position: 'absolute', right: 14, top: 12, display: 'flex', gap: 5 }}>
        {Array.from({ length: 6 }, (_, i) => (
          <motion.span
            key={i}
            initial={{ opacity: 0.15 }}
            animate={{ opacity: [0.15, 1, 0.15] }}
            transition={{ repeat: Infinity, duration: 1, delay: i * 0.12 }}
            style={{ width: 6, height: 6, borderRadius: '50%', background: '#39d353' }}
          />
        ))}
      </div>
      {/* validation thunk, late and brief */}
      <motion.div
        initial={{ scale: 1.9, opacity: 0 }}
        animate={{ scale: [1.9, 0.92, 1], opacity: [0, 0.95, 0] }}
        transition={{ duration: 0.75, delay: 0.95, times: [0, 0.35, 1] }}
        style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}
      >
        <div style={{ fontSize: 44, fontWeight: 800, color: '#c0392b', textShadow: '0 0 20px rgba(192,57,43,0.7)', transform: 'rotate(-8deg)' }}>割</div>
      </motion.div>
    </div>
  );
}

function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 22 }, (_, i) => ({
        id: i,
        x: (Math.random() - 0.5) * 300,
        y: -50 - Math.random() * 160,
        rot: Math.random() * 540,
        color: ['#2f9e57', '#95d9ad', '#e2c88c', '#26251f', '#c0392b'][i % 5],
        delay: Math.random() * 0.15,
      })),
    []
  );
  return (
    <>
      {pieces.map((p) => (
        <motion.div
          key={p.id}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
          animate={{ x: p.x, y: [0, p.y, p.y + 220], opacity: [1, 1, 0], rotate: p.rot }}
          transition={{ duration: 1, delay: p.delay, ease: 'easeOut' }}
          style={{ position: 'absolute', left: '50%', top: '30%', width: 8, height: 12, borderRadius: 2, background: p.color }}
        />
      ))}
    </>
  );
}

// --- Machine ---------------------------------------------------------------

function TicketMachine() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [rival, setRival] = useState<Ticket | null>(null);
  const [collected, setCollected] = useState(0);
  const slotRef = useRef<HTMLDivElement>(null);

  const you = useMemo<Ticket>(() => {
    const model = buildModel(0, 1.2);
    return {
      id: 'you',
      name: 'Acme Robotics',
      model,
      config: {},
      url: renderTicketUrl(model, 'Acme Robotics', {}),
      cutUrl: '',
    };
  }, []);

  const rivals = useMemo<Ticket[]>(
    () =>
      RIVAL_THEMES.map((t, i) => {
        const model = buildModel(t.phase, t.intensity);
        return {
          id: `rival-${i}`,
          name: t.name,
          model,
          config: t.config,
          url: renderTicketUrl(model, t.name, t.config),
          cutUrl: renderCutTicketUrl(model, t.name, t.config),
        };
      }),
    []
  );

  const [pool, setPool] = useState<string[]>(() => rivals.map((r) => r.id));

  const startCut = useCallback((ticket: Ticket) => {
    setRival(ticket);
    setPool((prev) => prev.filter((id) => id !== ticket.id));
    setPhase('feeding');
    window.setTimeout(() => setPhase('processing'), 640);
    window.setTimeout(() => {
      setPhase('ejecting');
      setCollected((n) => n + 1);
    }, 640 + 1150);
    window.setTimeout(() => setPhase('result'), 640 + 1150 + 820);
  }, []);

  const onRivalDragEnd = useCallback(
    (ticket: Ticket) => (_e: unknown, info: PanInfo) => {
      const slot = slotRef.current?.getBoundingClientRect();
      if (!slot || phase !== 'idle') return;
      const { x, y } = info.point;
      if (x >= slot.left - 30 && x <= slot.right + 30 && y >= slot.top - 60 && y <= slot.bottom + 90) startCut(ticket);
    },
    [phase, startCut]
  );

  const reset = () => {
    setPhase('idle');
    setRival(null);
    setPool(rivals.map((r) => r.id));
  };

  const insights = rival ? computeUsageShareInsights(rival.model) : null;
  const youInsights = computeUsageShareInsights(you.model);
  const shaking = phase === 'processing';

  return (
    <div style={{ minHeight: 900, padding: 28, fontFamily: 'Inter, sans-serif', color: '#26251f', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      <div style={{ textAlign: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>🎟️ Lody 割票机</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: '#8a8577' }}>
          把对手的票根喂进投票口 → 机器割票 → 吐出一张验讫的票 → 自动 PK。
        </p>
        <p style={{ margin: '2px 0 0', fontSize: 12, color: '#a29b88' }}>已收藏票根 · {collected}</p>
      </div>

      {/* Stage: the machine sits at the top; the feed ticket overflows above it (no
          reserved gap), and the tray below only claims space once a ticket is out. */}
      <motion.div
        animate={{ height: FACE_H + (phase === 'ejecting' || phase === 'result' ? TICKET_H + 20 : 0) }}
        transition={{ type: 'spring', stiffness: 200, damping: 26 }}
        style={{ position: 'relative', width: MACHINE_W, perspective: 1100 }}
      >
        {/* Feed ticket (whole) dropping into the top slot */}
        <AnimatePresence>
          {rival && phase === 'feeding' && (
            <motion.img
              key="feed"
              src={rival.url}
              initial={{ y: -TICKET_H - 16, rotateX: 0, scaleY: 1, opacity: 1 }}
              animate={{ y: -10, rotateX: 78, scaleY: 0.08, opacity: 0 }}
              transition={{ duration: 0.6, ease: 'easeIn' }}
              style={{ position: 'absolute', top: 0, left: (MACHINE_W - TICKET_W) / 2, width: TICKET_W, transformOrigin: 'bottom center', transformStyle: 'preserve-3d', borderRadius: 10, boxShadow: '0 14px 30px rgba(0,0,0,0.2)' }}
            />
          )}
        </AnimatePresence>

        {/* Machine body */}
        <motion.div
          animate={shaking ? { x: [0, -2.5, 2.5, -2, 2, 0], y: [0, 1, -1, 1, 0] } : { x: 0, y: 0 }}
          transition={shaking ? { repeat: Infinity, duration: 0.18 } : { duration: 0.2 }}
          style={{ position: 'absolute', top: 0, left: 0, width: MACHINE_W, height: FACE_H, borderRadius: 20, background: 'linear-gradient(180deg,#3a4048,#262b31)', boxShadow: '0 26px 60px rgba(20,24,30,0.4)', padding: '16px 22px' }}
        >
          {/* top slot */}
          <div
            ref={slotRef}
            style={{ height: 14, borderRadius: 8, background: phase === 'idle' ? '#11151a' : '#0a3d21', boxShadow: phase === 'idle' ? 'inset 0 3px 6px rgba(0,0,0,0.6)' : 'inset 0 0 10px #2f9e57', transition: 'all 0.3s' }}
          />
          {/* screen */}
          <div style={{ position: 'relative', height: FACE_H - 74, margin: '12px 0', borderRadius: 8, background: '#0d1116', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.06)' }}>
            {phase === 'idle' && (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'rgba(255,255,255,0.35)', fontSize: 13 }}>
                把票根拖到投票口 ↑（或点一下票根）
              </div>
            )}
            {(phase === 'processing' || phase === 'feeding') && rival && (
              <>
                {/* The real GLSL tear, seen through the machine window. */}
                <div style={{ position: 'absolute', inset: 0 }}>
                  <TicketCutShaderView
                    imageUrl={rival.url}
                    playing={phase === 'processing'}
                    durationMs={1050}
                  />
                </div>
                <ProcessingTheatre />
              </>
            )}
            {(phase === 'ejecting' || phase === 'result') && (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#39d353', fontSize: 13, letterSpacing: 2 }}>✓ 已验讫</div>
            )}
          </div>
          {/* output slot */}
          <div style={{ height: 12, borderRadius: 7, background: '#11151a', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.6)' }} />
        </motion.div>

        {/* Ejected CUT ticket coming out of the bottom into the tray */}
        <AnimatePresence>
          {rival && (phase === 'ejecting' || phase === 'result') && (
            <motion.div
              key="eject"
              initial={{ y: -40, rotateX: -78, scaleY: 0.08, opacity: 0 }}
              animate={{ y: 0, rotateX: 0, scaleY: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 170, damping: 15 }}
              style={{ position: 'absolute', top: FACE_H + 14, left: (MACHINE_W - TICKET_W) / 2, width: TICKET_W, transformOrigin: 'top center', transformStyle: 'preserve-3d' }}
            >
              <img src={rival.cutUrl} alt="cut" style={{ width: '100%', display: 'block', filter: 'drop-shadow(0 12px 22px rgba(0,0,0,0.22))' }} />
              {phase === 'ejecting' && <Confetti />}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* PK result */}
      <AnimatePresence>
        {phase === 'result' && rival && insights && (
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 200, damping: 22 }}
            style={{ width: MACHINE_W, background: '#f7f3ea', border: '1px solid #e4dac2', borderRadius: 18, padding: 20, boxShadow: '0 18px 40px rgba(30,26,18,0.16)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <strong style={{ fontSize: 16 }}>PK · 你 vs {rival.name}</strong>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#fff', background: you.model.totalValue >= rival.model.totalValue ? '#2f9e57' : '#c0392b', padding: '4px 10px', borderRadius: 999 }}>
                {you.model.totalValue >= rival.model.totalValue ? '你赢了 🎉' : '对手更猛 🔥'}
              </span>
            </div>
            <Stat label="Tokens" mine={you.model.totalValue} theirs={rival.model.totalValue} format={formatUsageCompact} />
            <Stat label="峰值日" mine={youInsights.peakCell?.value ?? 0} theirs={insights.peakCell?.value ?? 0} format={formatUsageCompact} />
            <Stat label="活跃天" mine={you.model.activeDays} theirs={rival.model.activeDays} format={(v) => String(v)} />
            <Stat label="最长连击" mine={you.model.longestStreak} theirs={rival.model.longestStreak} format={(v) => `${v}d`} />
            <button type="button" onClick={reset} style={{ marginTop: 16, width: '100%', padding: '10px', borderRadius: 10, border: 'none', background: '#26251f', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              再喂一张
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Rival pool */}
      <div style={{ marginTop: 4, textAlign: 'center' }}>
        <p style={{ fontSize: 12, color: '#8a8577', marginBottom: 10 }}>对手的票根（拖进机器，或点一下）</p>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
          {rivals
            .filter((r) => pool.includes(r.id))
            .map((r) => (
              <motion.div
                key={r.id}
                drag
                dragSnapToOrigin
                whileDrag={{ scale: 1.06, zIndex: 40, cursor: 'grabbing' }}
                whileHover={{ y: -4 }}
                onDragEnd={onRivalDragEnd(r)}
                onTap={() => phase === 'idle' && startCut(r)}
                title="拖进机器，或点一下直接割票"
                style={{ width: 190, cursor: 'grab', borderRadius: 10, overflow: 'hidden', boxShadow: '0 8px 20px rgba(0,0,0,0.14)', touchAction: 'none' }}
              >
                <img src={r.url} alt={r.name} style={{ width: '100%', display: 'block', pointerEvents: 'none' }} draggable={false} />
              </motion.div>
            ))}
          {pool.length === 0 && phase === 'idle' && (
            <span style={{ fontSize: 13, color: '#8a8577' }}>对手票根都割完啦 —— 点「再喂一张」重置。</span>
          )}
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof TicketMachine> = {
  title: 'Settings/TicketCutMachine',
  component: TicketMachine,
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Story = StoryObj<typeof TicketMachine>;

export const Machine: Story = {};
