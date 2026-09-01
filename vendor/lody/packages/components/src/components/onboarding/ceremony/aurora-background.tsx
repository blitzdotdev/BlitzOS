import { Water } from '@paper-design/shaders-react';

const BACKDROP_MAX_PIXELS = 1280 * 720;

export type CeremonyBackgroundProps = {
  opacity?: number;
  speed?: number;
  className?: string;
  style?: React.CSSProperties;
};

/**
 * A restrained underwater light field for the opening ceremony.
 *
 * The geometric panel shader read as architecture behind a jellyfish mark. This
 * keeps the cool, operational palette but changes the material: shallow
 * refraction, restrained caustics and slow drift. It should feel like light
 * moving through glass and water, not a literal ocean scene or a soft lifestyle
 * gradient.
 */
export function CeremonyBackground({
  opacity = 1,
  speed = 1,
  className,
  style,
}: CeremonyBackgroundProps): React.JSX.Element {
  return (
    <div
      className={className}
      style={{ width: '100%', height: '100%', overflow: 'hidden', opacity, ...style }}
    >
      <Water
        className="absolute inset-0"
        style={{ width: '100%', height: '100%' }}
        colorBack="#dce5e7"
        colorHighlight="#fbffff"
        highlights={0.28}
        layering={0.58}
        edges={0.16}
        waves={0.3}
        caustic={0.24}
        size={0.82}
        fit="cover"
        scale={1.12}
        rotation={-6}
        speed={0.1 * speed}
        maxPixelCount={BACKDROP_MAX_PIXELS}
        minPixelRatio={1}
      />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(ellipse at 18% 18%, rgba(255,255,255,.58), transparent 46%), radial-gradient(ellipse at 82% 72%, rgba(42,93,111,.13), transparent 56%), linear-gradient(180deg, rgba(255,255,255,.2), rgba(33,68,79,.06))',
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.1]"
        style={{
          backgroundImage: 'linear-gradient(90deg, rgba(25,58,68,.28) 1px, transparent 1px)',
          backgroundSize: '88px 100%',
          maskImage: 'linear-gradient(180deg, transparent, black 20%, black 80%, transparent)',
          WebkitMaskImage:
            'linear-gradient(180deg, transparent, black 20%, black 80%, transparent)',
        }}
      />
    </div>
  );
}
