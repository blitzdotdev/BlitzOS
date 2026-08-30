import jellyfishSheet from '@/assets/onboarding/lody-jellyfish-animation-8f.png';
import pearlSheet from '@/assets/onboarding/session-pearl-animation-8f.png';
import fishSheet from '@/assets/onboarding/agent-companion-fish-animation-8f.png';
import distantFishSchool from '@/assets/onboarding/distant-fish-school-8f.png';
import distantFishSchoolBright from '@/assets/onboarding/distant-fish-school-bright-8f.png';
import shellSheet from '@/assets/onboarding/issue-shell-animation-8f.png';
import coralSheet from '@/assets/onboarding/project-coral-reef-animation-8f.png';
import underwaterBasePlate from '@/assets/onboarding/underwater-base-plate.png';
import rockPileDecoration from '@/assets/onboarding/decorations/rock-pile-static.png';
import rockPileDecoration00 from '@/assets/onboarding/decorations/rock-pile-static-00.png';
import rockPileDecoration04 from '@/assets/onboarding/decorations/rock-pile-static-04.png';
import rockPileDecoration06 from '@/assets/onboarding/decorations/rock-pile-static-06.png';
import rockPileDecoration07 from '@/assets/onboarding/decorations/rock-pile-static-07.png';
import kelpRockDecoration00 from '@/assets/onboarding/decorations/kelp-rock-static-00.png';
import kelpRockDecoration04 from '@/assets/onboarding/decorations/kelp-rock-static-04.png';
import kelpRockDecoration07 from '@/assets/onboarding/decorations/kelp-rock-static-07.png';
import seaweedDecoration from '@/assets/onboarding/decorations/seaweed-static.png';
import seaweedDecoration01 from '@/assets/onboarding/decorations/seaweed-static-01.png';
import seaweedDecoration06 from '@/assets/onboarding/decorations/seaweed-static-06.png';
import starfishDecoration from '@/assets/onboarding/decorations/starfish-static.png';
import starfishDecoration00 from '@/assets/onboarding/decorations/starfish-static-00.png';
import starfishDecoration03 from '@/assets/onboarding/decorations/starfish-static-03.png';
import starfishDecoration06 from '@/assets/onboarding/decorations/starfish-static-06.png';
import starfishDecoration07 from '@/assets/onboarding/decorations/starfish-static-07.png';
import { cn } from '@/lib/utils';

// The underwater world that lives at the bottom of the intro. It is a pure
// overlay: it mounts nothing inside the shot system, intercepts no pointer
// events, and the intro above it is untouched.
//
// Every animated sprite is a 4x2 spritesheet (8 frames) whose FRAME carries
// generous transparent padding. If the frame were placed directly, the visible
// prop would hover above wherever it was meant to sit — so each sprite is
// trimmed to its measured content box (alpha-bbox across all 8 frames) and the
// layout below positions CONTENT, not frames. `bottom: 0` means "resting on
// the seabed", and the placement numbers stay true at any viewport. The source
// cell aspect ratio must stay intact, otherwise the browser stretches the art.

/** Content bounding box of a sheet, as fractions of one frame. */
type Trim = { x: number; y: number; w: number; h: number };

type SheetSpec = {
  src: string;
  /** Width / height of ONE frame (sheet w/4, sheet h/2). */
  frameAspect: number;
  trim: Trim;
};

// Sheets are normalized by tmp/imagegen/normalize-sprites.mjs. That script
// preserves the source sheet dimensions, keeps every frame inside its fixed
// grid cell, and aligns content without changing the cell aspect ratio. Re-run
// it and update these measured trims if a sheet is regenerated.
const SHEETS = {
  jellyfish: {
    src: jellyfishSheet,
    frameAspect: 362 / 543,
    trim: {
      x: 0.06077348066298342,
      y: 0.26151012891344383,
      w: 0.8397790055248618,
      h: 0.49355432780847147,
    },
  },
  pearl: {
    src: pearlSheet,
    frameAspect: 350.5 / 561,
    trim: {
      x: 0.025677603423680456,
      y: 0.11942959001782531,
      w: 0.8445078459343794,
      h: 0.7165775401069518,
    },
  },
  fish: {
    src: fishSheet,
    frameAspect: 350.5 / 561,
    trim: {
      x: 0.0456490727532097,
      y: 0.23351158645276293,
      w: 0.7703281027104137,
      h: 0.5080213903743316,
    },
  },
  shell: {
    src: shellSheet,
    frameAspect: 384 / 512,
    trim: {
      x: 0.018229166666666668,
      y: 0.12109375,
      w: 0.8828125,
      h: 0.779296875,
    },
  },
  coral: {
    src: coralSheet,
    frameAspect: 350.5 / 561,
    trim: {
      x: 0.04850213980028531,
      y: 0.2014260249554367,
      w: 0.9243937232524965,
      h: 0.5347593582887701,
    },
  },
} satisfies Record<string, SheetSpec>;

// The base plate is a 1672 × 941 world, not a decorative wallpaper. Everything
// in the scene is positioned inside a single cover-scaled world layer so its
// reef line, floor perspective and props always receive the same crop.
const UNDERWATER_WORLD = {
  width: 1672,
  height: 941,
  // Reference bands measured from the base plate. Keep new ground props in
  // these bands instead of choosing positions from the viewport height.
  rearReef: { top: 600, bottom: 735 },
  vanishingLine: 748,
  middleFloor: { top: 748, bottom: 830 },
  foregroundFloor: { top: 830, bottom: 941 },
} as const;

// This is the camera-space coordinate system for objects that belong to the
// seabed. X is lateral position, Z runs from foreground (0) to the vanishing
// line (1), and Y is elevation above the ground in source-world pixels.
const UNDERWATER_CAMERA = {
  centreX: UNDERWATER_WORLD.width / 2,
  vanishingY: UNDERWATER_WORLD.vanishingLine,
  foregroundY: 910,
  nearHalfWidth: 760,
  farHalfWidth: 360,
  nearScale: 1,
  farScale: 0.38,
} as const;

type WorldPoint = {
  /** Lateral coordinate on the ground plane. -1 / 1 are the near floor edges. */
  x: number;
  /** Elevation above the floor in source-world pixels. */
  y?: number;
  /** 0 = foreground floor, 1 = vanishing line. */
  z: number;
};

function interpolate(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function projectWorldPoint({ x, y = 0, z }: WorldPoint): { x: number; y: number; scale: number } {
  const depth = Math.min(1, Math.max(0, z));
  const groundY = interpolate(UNDERWATER_CAMERA.foregroundY, UNDERWATER_CAMERA.vanishingY, depth);
  const halfWidth = interpolate(
    UNDERWATER_CAMERA.nearHalfWidth,
    UNDERWATER_CAMERA.farHalfWidth,
    depth
  );
  const scale = interpolate(UNDERWATER_CAMERA.nearScale, UNDERWATER_CAMERA.farScale, depth);
  return {
    x: UNDERWATER_CAMERA.centreX + x * halfWidth,
    y: groundY - y * scale,
    scale,
  };
}

// Painted into the environment plate. These are source-plate pixel anchors,
// deliberately separate from projected scene objects until the terrain height
// field is calibrated from the base artwork.
const BASE_CORAL_MARKS = [
  { label: 'base coral L-rear', x: 58, y: 752 },
  { label: 'base coral L-near', x: 228, y: 808 },
  { label: 'base coral R-near', x: 1508, y: 762 },
  { label: 'base coral R-rear', x: 1614, y: 732 },
] as const;

// Source-pixel control lines traced from the visible junction between each
// painted side bank and the central sand channel. They are deliberately not a
// height function: approving these asymmetric ridges comes before deriving a
// triangulated terrain surface from them.
const BASE_TERRAIN_RIDGES = {
  left: [
    [0, 566],
    [72, 596],
    [158, 640],
    [276, 690],
    [414, 724],
    [548, 744],
    [654, 750],
  ],
  right: [
    [1672, 554],
    [1580, 566],
    [1482, 600],
    [1372, 648],
    [1256, 698],
    [1130, 738],
    [1018, 750],
  ],
} as const;

type SpriteProps = {
  sheet: SheetSpec;
  /** Seconds for a full 8-frame loop. */
  duration: number;
  /** Negative delays desynchronise loops that share a duration. */
  delay?: number;
  className?: string;
  style?: React.CSSProperties;
};

/**
 * A spritesheet animation whose element box IS the sprite's content box: the
 * wrapper takes the content size, and the full frame overflows it by exactly
 * the trimmed padding. Positioning classes on the wrapper therefore place the
 * visible prop itself.
 */
function Sprite({ sheet, duration, delay = 0, className, style }: SpriteProps): React.JSX.Element {
  const { src, frameAspect, trim } = sheet;
  return (
    <div
      aria-hidden
      className={className}
      style={{ aspectRatio: `${(trim.w * frameAspect) / trim.h}`, ...style }}
    >
      <div className="relative size-full">
        <div
          className="lody-sprite-8f absolute"
          style={{
            width: `${100 / trim.w}%`,
            height: `${100 / trim.h}%`,
            left: `${-(trim.x / trim.w) * 100}%`,
            top: `${-(trim.y / trim.h) * 100}%`,
            backgroundImage: `url(${src})`,
            animationDuration: `${duration}s`,
            animationDelay: `${delay}s`,
          }}
        />
      </div>
    </div>
  );
}

/** A horizontal sprite seated on the central floor plane. Keep flat-bottomed
 * assets (the project coral reef and shell) here; side banks use only painted
 * background detail until we have slope-shaped source art. */
function FloorSprite({
  point,
  size,
  sheet,
  duration,
  delay,
  className,
}: SpriteProps & {
  point: WorldPoint;
  size: number;
}): React.JSX.Element {
  const projected = projectWorldPoint(point);
  const aspect = (sheet.trim.w * sheet.frameAspect) / sheet.trim.h;
  const width = size * projected.scale;
  const height = width / aspect;

  return (
    <Sprite
      sheet={sheet}
      duration={duration}
      delay={delay}
      className={cn('absolute', className)}
      style={{
        left: `${((projected.x - width / 2) / UNDERWATER_WORLD.width) * 100}%`,
        top: `${((projected.y - height) / UNDERWATER_WORLD.height) * 100}%`,
        width: `${(width / UNDERWATER_WORLD.width) * 100}%`,
      }}
    />
  );
}

/** A static object seated on the central floor projection. Unlike `bottom`
 * percentage placement, every floor prop now shares the base plate's X/Y/Z
 * camera and therefore keeps its scale and footing when the window changes. */
function GroundDecoration({
  src,
  point,
  size,
  className,
}: {
  src: string;
  point: WorldPoint;
  /** Visible width at z=0, in source-world pixels. */ size: number;
  className?: string;
}): React.JSX.Element {
  const projected = projectWorldPoint(point);
  const width = size * projected.scale;
  return (
    <img
      aria-hidden
      src={src}
      alt=""
      draggable={false}
      className={cn('lody-static-decoration absolute', className)}
      style={{
        left: `${(projected.x / UNDERWATER_WORLD.width) * 100}%`,
        top: `${(projected.y / UNDERWATER_WORLD.height) * 100}%`,
        width: `${(width / UNDERWATER_WORLD.width) * 100}%`,
        transform: 'translate(-50%, -100%)',
      }}
    />
  );
}

/** A full-cell sheet for background life, where generous transparent padding
    is desirable because scale itself communicates depth. */
function AmbientSheet({
  src,
  frames,
  duration,
  delay = 0,
  className,
  style,
}: {
  src: string;
  frames: 8 | 9;
  duration: number;
  delay?: number;
  className?: string;
  style?: React.CSSProperties;
}): React.JSX.Element {
  return (
    <div
      aria-hidden
      className={cn(frames === 8 ? 'lody-sprite-8f' : 'lody-sprite-9f', className)}
      style={{
        backgroundImage: `url(${src})`,
        animationDuration: `${duration}s`,
        animationDelay: `${delay}s`,
        ...style,
      }}
    />
  );
}

function StaticDecoration({
  src,
  className,
}: {
  src: string;
  className: string;
}): React.JSX.Element {
  return (
    <img
      aria-hidden
      src={src}
      alt=""
      draggable={false}
      className={cn('lody-static-decoration absolute', className)}
    />
  );
}

/**
 * A stream of rising bubbles. Bubbles are plain CSS radial-gradients rising on
 * a keyframe, staggered by delay so the column never moves in lockstep.
 */
function BubbleStream({
  left,
  count,
  height,
  seed = 0,
}: {
  left: string;
  count: number;
  /** Pixel height the bubbles climb before resetting. */
  height: number;
  /** Offsets the pseudo-random stagger between streams. */
  seed?: number;
}): React.JSX.Element {
  return (
    <div className="absolute bottom-0 z-20" style={{ left }}>
      {Array.from({ length: count }, (_, i) => {
        const size = 4 + ((i * 7 + seed * 13) % 9);
        const drift = ((i * 11 + seed * 5) % 17) - 8;
        const duration = 6 + ((i * 3 + seed) % 5);
        const delay = -(((i * 2.3 + seed * 1.7) % duration) + 0.1);
        return (
          <span
            key={i}
            className="lody-bubble"
            style={
              {
                width: size,
                height: size,
                marginLeft: drift,
                animationDuration: `${duration}s`,
                animationDelay: `${delay}s`,
                '--lody-bubble-rise': `${height}px`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

/** Slow-drifting plankton specks that give the water column some depth. */
function DriftSpecks(): React.JSX.Element {
  return (
    <>
      {Array.from({ length: 10 }, (_, i) => {
        const size = 2 + (i % 3);
        return (
          <span
            key={i}
            className="lody-speck"
            style={{
              width: size,
              height: size,
              left: `${(i * 37) % 100}%`,
              bottom: `${8 + ((i * 19) % 30)}%`,
              animationDuration: `${9 + (i % 4) * 3}s`,
              animationDelay: `${-(i * 1.3)}s`,
            }}
          />
        );
      })}
    </>
  );
}

/** Storybook-only inspection aid for the camera-space floor projection. */
function WorldCoordinateDebug(): React.JSX.Element {
  const zLines = [0, 0.25, 0.5, 0.75, 1];
  const xLines = [-1, -0.5, 0, 0.5, 1];
  const farLeft = projectWorldPoint({ x: -1, z: 1 });
  const farRight = projectWorldPoint({ x: 1, z: 1 });
  const nearLeft = projectWorldPoint({ x: -1, z: 0 });
  const nearRight = projectWorldPoint({ x: 1, z: 0 });
  const origin = projectWorldPoint({ x: 0, z: 1 });

  return (
    <svg
      aria-hidden
      className="lody-underwater-debug-space pointer-events-none absolute inset-0 z-50 size-full overflow-visible"
      viewBox={`0 0 ${UNDERWATER_WORLD.width} ${UNDERWATER_WORLD.height}`}
      preserveAspectRatio="none"
    >
      <g className="lody-underwater-debug-floor">
        <path
          d={`M ${nearLeft.x} ${nearLeft.y} L ${farLeft.x} ${farLeft.y} L ${farRight.x} ${farRight.y} L ${nearRight.x} ${nearRight.y} Z`}
        />
        {zLines.map((z) => {
          const left = projectWorldPoint({ x: -1, z });
          const right = projectWorldPoint({ x: 1, z });
          return <line key={`z-${z}`} x1={left.x} y1={left.y} x2={right.x} y2={right.y} />;
        })}
        {xLines.map((x) => {
          const near = projectWorldPoint({ x, z: 0 });
          const far = projectWorldPoint({ x, z: 1 });
          return <line key={`x-${x}`} x1={near.x} y1={near.y} x2={far.x} y2={far.y} />;
        })}
      </g>
      <g className="lody-underwater-debug-ridge">
        {Object.entries(BASE_TERRAIN_RIDGES).map(([side, points]) => (
          <g key={side}>
            <polyline points={points.map(([x, y]) => `${x},${y}`).join(' ')} />
            {points.map(([x, y], index) => (
              <circle key={`${side}-${index}`} cx={x} cy={y} r="6" />
            ))}
          </g>
        ))}
      </g>
      <g className="lody-underwater-debug-axis">
        <line x1={nearLeft.x} y1={nearLeft.y} x2={nearRight.x} y2={nearRight.y} />
        <line x1={nearLeft.x} y1={nearLeft.y} x2={origin.x} y2={origin.y} />
        <line x1={origin.x} y1={origin.y} x2={origin.x} y2={origin.y - 230} />
      </g>
      <g className="lody-underwater-debug-copy">
        <text x={nearRight.x - 8} y={nearRight.y - 10}>
          X · lateral
        </text>
        <text x={origin.x + 10} y={origin.y + 22}>
          Z · depth → 1
        </text>
        <text x={origin.x + 10} y={origin.y - 218}>
          Y · elevation
        </text>
        <text x="22" y="34">
          CAMERA SPACE · X lateral · Y elevation · Z depth
        </text>
        <text x="22" y="54">
          world 1672 × 941 · floor projection, not viewport grid
        </text>
        <text x="22" y="74">
          orange · painted bank ridge controls (mesh intentionally not built yet)
        </text>
      </g>
      <g className="lody-underwater-debug-base-mark">
        {BASE_CORAL_MARKS.map((mark) => (
          <g key={mark.label}>
            <circle cx={mark.x} cy={mark.y} r="9" />
            <line x1={mark.x} y1={mark.y} x2={mark.x + 34} y2={mark.y - 30} />
            <text x={mark.x + 40} y={mark.y - 34}>
              {mark.label} · {mark.x},{mark.y}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

export function UnderwaterScene({
  visible,
  playing,
  debug = false,
  showTextures = false,
}: {
  /** Fades the whole scene in/out. It stays mounted either way. */
  visible: boolean;
  playing: boolean;
  /** Coordinate guide for visual calibration; Storybook only. */
  debug?: boolean;
  /** Temporary scene-asset gate. Debug geometry remains available when false. */
  showTextures?: boolean;
}): React.JSX.Element {
  return (
    <div
      aria-hidden
      className={cn(
        // Its containing block is OnboardingCeremony's `fixed inset-0` stage,
        // so this is exactly the viewport rather than content-height based.
        'pointer-events-none absolute inset-0 size-full overflow-hidden',
        !playing && 'lody-scene-paused'
      )}
      style={{
        opacity: visible ? 1 : 0,
        transition: 'opacity 1600ms ease',
      }}
    >
      <div
        className="lody-underwater-world"
        style={{
          aspectRatio: `${UNDERWATER_WORLD.width} / ${UNDERWATER_WORLD.height}`,
        }}
      >
        {/* The environment plate and water light remain visible while scene
          sprites are temporarily hidden. */}
        <img
          aria-hidden
          src={underwaterBasePlate}
          alt=""
          draggable={false}
          className="lody-underwater-base absolute inset-0 z-0 size-full"
        />
        <div aria-hidden className="lody-underwater-depth absolute inset-0 z-0" />
        <div className="lody-seabed absolute inset-x-0 bottom-0 z-10 h-[34%]" />
        <div className="lody-seaglow absolute bottom-[-12%] left-[8%] z-10 h-[38%] w-[48%]" />
        <div
          className="lody-seaglow absolute bottom-[-14%] right-[2%] z-10 h-[35%] w-[38%]"
          style={{ opacity: 0.7 }}
        />

        {showTextures && (
          <>
            {/* Stage coordinates: x moves left-to-right across the 0–100% world;
          the seabed is y=0. Foreground lives below 30%, midwater below 55%,
          and distant life below 68%, leaving the upper centre clear for copy. */}
            <DriftSpecks />

            {/* Distant layer — low contrast and small scale establishes the vanishing
          line instead of filling the screen with repeated foreground fish. */}
            <div className="lody-distant-school-drift absolute bottom-[46%] left-[-12%] z-10 aspect-square w-[clamp(56px,6vw,94px)] opacity-40">
              <AmbientSheet
                src={distantFishSchool}
                frames={8}
                duration={1.55}
                delay={-0.8}
                className="size-full"
              />
            </div>
            <div
              className="lody-jelly-bob absolute bottom-[55%] left-[58%] z-10 opacity-24"
              style={{ animationDuration: '13s', animationDelay: '-6s' }}
            >
              <Sprite
                sheet={SHEETS.jellyfish}
                duration={1.65}
                delay={-1.2}
                className="w-[clamp(22px,2.1vw,34px)]"
              />
            </div>
            <div
              className="lody-distant-school-glide absolute bottom-[38%] left-[-16%] z-10 aspect-[0.625] w-[clamp(104px,11vw,168px)] opacity-35"
              style={{ animationDuration: '68s', animationDelay: '-31s' }}
            >
              <AmbientSheet
                src={distantFishSchoolBright}
                frames={8}
                duration={1.8}
                delay={-0.9}
                className="size-full"
              />
            </div>

            {/* Midwater life: the two schools are distinct assets, while a few single
          fish read as nearer passers-by rather than repeated wallpaper. */}
            <div
              className="lody-jelly-bob absolute bottom-[38%] right-[27%] z-20 opacity-58"
              style={{ animationDuration: '9s', animationDelay: '-4s' }}
            >
              <Sprite
                sheet={SHEETS.jellyfish}
                duration={1.35}
                delay={-0.4}
                className="w-[clamp(42px,4.2vw,64px)]"
              />
            </div>
            <div className="lody-fish-sway absolute bottom-[22%] left-[58%] z-20">
              <Sprite
                sheet={SHEETS.fish}
                duration={1.05}
                delay={-0.4}
                className="w-[clamp(48px,4.6vw,72px)]"
              />
            </div>
            <div
              className="lody-fish-swim absolute bottom-[31%] left-0 z-20 opacity-65"
              style={{ animationDuration: '42s', animationDelay: '-19s' }}
            >
              <Sprite
                sheet={SHEETS.fish}
                duration={1.25}
                delay={-0.9}
                className="w-[clamp(32px,3.2vw,50px)]"
              />
            </div>
            <div className="lody-fish-sway absolute bottom-[43%] right-[11%] z-20 opacity-52">
              <Sprite
                sheet={SHEETS.fish}
                duration={1.4}
                delay={-0.7}
                className="w-[clamp(28px,2.8vw,42px)]"
              />
            </div>
            <div className="lody-fish-sway absolute bottom-[34%] left-[43%] z-20 opacity-66">
              <Sprite
                sheet={SHEETS.fish}
                duration={1.2}
                delay={-0.2}
                className="w-[clamp(34px,3.5vw,52px)]"
              />
            </div>

            {/* Background floor accents are deliberately static. They start at the
          horizon and step forward in depth, leaving the near floor to the
          larger shell, Lody, and animated seaweed below. */}
            <GroundDecoration
              src={rockPileDecoration07}
              point={{ x: -0.18, z: 0.94 }}
              size={88}
              className="z-10 opacity-22"
            />
            <GroundDecoration
              src={seaweedDecoration06}
              point={{ x: 0.58, z: 0.88 }}
              size={106}
              className="z-10 opacity-22"
            />
            <FloorSprite
              point={{ x: -0.48, z: 0.96 }}
              size={154}
              sheet={SHEETS.coral}
              duration={2.1}
              delay={-1.1}
              className="z-10 opacity-28"
            />
            <FloorSprite
              point={{ x: 0.46, z: 0.91 }}
              size={132}
              sheet={SHEETS.coral}
              duration={2.45}
              delay={-0.3}
              className="z-10 opacity-24"
            />
            <GroundDecoration
              src={rockPileDecoration07}
              point={{ x: 0.08, z: 0.97 }}
              size={70}
              className="z-10 opacity-22"
            />
            <GroundDecoration
              src={kelpRockDecoration00}
              point={{ x: 0.3, z: 0.85 }}
              size={126}
              className="z-10 opacity-24"
            />
            <GroundDecoration
              src={seaweedDecoration01}
              point={{ x: -0.62, z: 0.86 }}
              size={92}
              className="z-10 opacity-22"
            />
            <GroundDecoration
              src={kelpRockDecoration07}
              point={{ x: -0.82, z: 0.78 }}
              size={136}
              className="z-10 opacity-24"
            />
            <GroundDecoration
              src={seaweedDecoration}
              point={{ x: 0.8, z: 0.84 }}
              size={94}
              className="z-10 opacity-20"
            />

            {/* Flat-bottomed semantic props get their own middle plane. This is
          deliberately larger than the horizon detail, while still behind the
          hero and the foreground shell. */}
            <FloorSprite
              point={{ x: -0.48, z: 0.44 }}
              size={232}
              sheet={SHEETS.coral}
              duration={2.25}
              delay={-0.7}
              className="z-[15] opacity-54"
            />
            <FloorSprite
              point={{ x: 0.42, z: 0.65 }}
              size={196}
              sheet={SHEETS.coral}
              duration={2.55}
              delay={-1.4}
              className="z-[15] opacity-44"
            />
            <FloorSprite
              point={{ x: -0.03, z: 0.55 }}
              size={146}
              sheet={SHEETS.shell}
              duration={2.75}
              delay={-0.9}
              className="z-[15] opacity-70"
            />
            <FloorSprite
              point={{ x: -0.03, y: 56, z: 0.55 }}
              size={54}
              sheet={SHEETS.pearl}
              duration={1.95}
              delay={-1.2}
              className="z-[16] opacity-78"
            />

            {/* Foreground seabed uses different static variants from the supplied
          prop library. Fish, jellyfish, bubbles and semantic props carry the
          motion; the environment itself does not pulse in lockstep. */}
            <StaticDecoration
              src={kelpRockDecoration00}
              className="bottom-[-3%] left-[10%] z-20 w-[clamp(58px,6.4vw,98px)] opacity-58"
            />
            <StaticDecoration
              src={seaweedDecoration01}
              className="bottom-[-2%] left-[34%] z-20 w-[clamp(42px,4.8vw,72px)] opacity-68"
            />
            <StaticDecoration
              src={kelpRockDecoration04}
              className="bottom-[-3%] right-[27%] z-20 w-[clamp(64px,7.2vw,110px)] opacity-56"
            />

            <StaticDecoration
              src={rockPileDecoration00}
              className="bottom-[1%] left-[39%] z-30 w-[clamp(56px,6vw,90px)] opacity-74"
            />
            <StaticDecoration
              src={rockPileDecoration}
              className="bottom-[1%] right-[23%] z-30 w-[clamp(48px,5.2vw,80px)] opacity-78"
            />
            <StaticDecoration
              src={rockPileDecoration04}
              className="bottom-[1%] left-[64%] z-30 w-[clamp(42px,4.8vw,72px)] opacity-72"
            />
            <StaticDecoration
              src={rockPileDecoration06}
              className="bottom-0 right-[31%] z-30 w-[clamp(48px,5.4vw,82px)] opacity-70"
            />
            <StaticDecoration
              src={rockPileDecoration07}
              className="bottom-[1%] left-[54%] z-30 w-[clamp(34px,3.8vw,58px)] opacity-74"
            />

            <StaticDecoration
              src={starfishDecoration00}
              className="bottom-[2%] left-[47%] z-30 w-[clamp(24px,2.7vw,40px)] opacity-86"
            />
            <StaticDecoration
              src={starfishDecoration}
              className="bottom-[2%] left-[57%] z-30 w-[clamp(25px,3vw,44px)] opacity-90"
            />
            <StaticDecoration
              src={starfishDecoration03}
              className="bottom-[2%] left-[73%] z-30 w-[clamp(24px,2.8vw,42px)] opacity-86"
            />
            <StaticDecoration
              src={starfishDecoration06}
              className="bottom-[9%] right-[18%] z-30 w-[clamp(20px,2.3vw,34px)] opacity-74"
            />
            <StaticDecoration
              src={starfishDecoration07}
              className="bottom-[1%] right-[41%] z-30 w-[clamp(21px,2.5vw,37px)] opacity-82"
            />

            {/* Foreground anchors — the shell and low seabed props frame the near
          floor. Coral belongs in the middle-to-far reef layer above. */}
            <div className="absolute bottom-[-1%] right-[4%] z-30 w-[clamp(138px,14vw,220px)]">
              <Sprite sheet={SHEETS.shell} duration={2.6} delay={-0.4} />
              <div className="absolute bottom-[24%] left-[30%] w-[38%]">
                <div className="lody-pearl-glow absolute inset-[-45%]" />
                <Sprite sheet={SHEETS.pearl} duration={1.85} delay={-1.1} className="relative" />
              </div>
            </div>
            <Sprite
              sheet={SHEETS.pearl}
              duration={2.35}
              delay={-0.5}
              className="absolute bottom-[1%] left-[32%] z-30 w-[clamp(18px,1.8vw,28px)] opacity-72"
            />

            {/* Lody is the hero in the nearest moving plane: large enough to lead,
          but lifted above the floor so the coral and shell keep their depth. */}
            <div className="lody-jelly-bob absolute bottom-[25%] left-[18%] z-30">
              <Sprite
                sheet={SHEETS.jellyfish}
                duration={1.15}
                className="w-[clamp(92px,8.4vw,132px)]"
              />
            </div>
          </>
        )}
        {/* Bubbles belong to the water layer, rather than the toggled props. */}
        <BubbleStream left="8%" count={4} height={260} seed={1} />
        <BubbleStream left="24%" count={3} height={190} seed={5} />
        <BubbleStream left="47%" count={3} height={170} seed={2} />
        <BubbleStream left="88%" count={4} height={240} seed={4} />
        {debug && <WorldCoordinateDebug />}
      </div>
    </div>
  );
}
