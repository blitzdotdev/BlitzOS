import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * GLSL ticket tear.
 *
 * The ticket artwork is uploaded as a texture and torn in the fragment shader:
 * the boundary is an fbm-displaced line (so it wanders like a real rip instead of
 * a ruler-straight cut), the last few pixels are alpha-eroded with a second, much
 * finer noise band to expose paper fibres, and the freshly separated edge gets a
 * darkened core plus a light fibre highlight. The stub half is translated in UV
 * space as the cut descends, so one draw call renders both pieces.
 */
const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform sampler2D uTex;
  uniform float uTearX;     // nominal tear position, 0..1 across the ticket
  uniform float uCut;       // blade travel, 0 = untouched, 1 = fully cut
  uniform float uSeparate;  // how far the stub has slid away, in UV units
  uniform float uAspect;    // width / height, to keep noise isotropic
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.02;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = vUv;

    // Two octave bands: a slow wander plus a fine crinkle along the rip.
    float wander = fbm(vec2(uv.y * 22.0, 3.7)) - 0.5;
    float crinkle = fbm(vec2(uv.y * 130.0, 9.1)) - 0.5;
    float tear = uTearX + wander * 0.017 + crinkle * 0.005;

    // The blade enters at the top (v = 1) and travels down.
    float bladeY = 1.0 - uCut;
    float cutRow = step(bladeY, uv.y);

    float stubSide = step(tear, uv.x);
    vec2 sampleUv = uv;
    sampleUv.x -= stubSide * uSeparate * cutRow;

    // Do not smear the stub texture back over the main body once it slides.
    if (stubSide > 0.5 && sampleUv.x < tear - 0.0015) discard;

    vec4 texel = texture2D(uTex, sampleUv);

    float dist = abs(uv.x - tear);

    // Paper fibres: erode a sub-millimetre band with high frequency noise so the
    // separated edge is ragged per-pixel rather than a clean vector boundary.
    if (cutRow > 0.5 && dist < 0.0075) {
      float fibre = fbm(vec2(uv.y * 220.0, uv.x * 90.0));
      float bite = 1.0 - smoothstep(0.0, 0.0075, dist);
      if (fibre < bite * 0.62) discard;
    }

    // Torn edge shading: a darker core with a bright fibre lip just inside it.
    float core = (1.0 - smoothstep(0.0, 0.006, dist)) * cutRow;
    float lip = (1.0 - smoothstep(0.004, 0.012, dist)) * cutRow;
    texel.rgb = mix(texel.rgb, texel.rgb * 0.74, core * 0.85);
    texel.rgb += vec3(0.10, 0.09, 0.07) * lip * 0.5;

    // Blade head glow, only while the cut is actually travelling.
    if (uCut > 0.001 && uCut < 0.999) {
      vec2 head = vec2((uv.x - tear) * uAspect, uv.y - bladeY);
      float glow = 1.0 - smoothstep(0.0, 0.09, length(head));
      texel.rgb += vec3(0.22, 0.95, 0.38) * glow * 0.75;

      // Thin hot filament riding the seam behind the head.
      float seam = (1.0 - smoothstep(0.0, 0.0035, dist)) * cutRow;
      texel.rgb += vec3(0.30, 1.0, 0.45) * seam * 0.35;
    }

    gl_FragColor = texel;
  }
`;

type CutPlaneProps = {
  texture: THREE.Texture;
  aspect: number;
  playing: boolean;
  durationMs: number;
  separateBy: number;
  onDone?: () => void;
};

function CutPlane({ texture, aspect, playing, durationMs, separateBy, onDone }: CutPlaneProps) {
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const startRef = useRef<number | null>(null);
  const doneRef = useRef(false);
  const { size } = useThree();

  const uniforms = useMemo(
    () => ({
      uTex: { value: texture },
      uTearX: { value: 0.82 },
      uCut: { value: 0 },
      uSeparate: { value: 0 },
      uAspect: { value: aspect },
    }),
    [aspect, texture]
  );

  useEffect(() => {
    startRef.current = null;
    doneRef.current = false;
    if (materialRef.current) {
      materialRef.current.uniforms.uCut!.value = 0;
      materialRef.current.uniforms.uSeparate!.value = 0;
    }
  }, [playing, texture]);

  useFrame(({ clock }) => {
    const material = materialRef.current;
    if (!material || !playing) return;
    if (startRef.current === null) startRef.current = clock.elapsedTime;

    const t = Math.min(1, (clock.elapsedTime - startRef.current) / (durationMs / 1000));
    // Blade accelerates in, then eases as it exits the bottom edge.
    const cut = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    material.uniforms.uCut!.value = cut;
    // The stub only drifts once the cut is well underway.
    const sep = Math.max(0, (t - 0.55) / 0.45);
    material.uniforms.uSeparate!.value = (1 - (1 - sep) ** 3) * separateBy;

    if (t >= 1 && !doneRef.current) {
      doneRef.current = true;
      onDone?.();
    }
  });

  // R3F's default orthographic camera maps one world unit to one pixel, so the
  // plane is sized in pixels and letterboxed to preserve the ticket aspect.
  const viewAspect = size.width / Math.max(1, size.height);
  const planeW = viewAspect > aspect ? size.height * aspect : size.width;
  const planeH = viewAspect > aspect ? size.height : size.width / aspect;

  return (
    <mesh>
      <planeGeometry args={[planeW, planeH]} />
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={VERTEX_SHADER}
        fragmentShader={FRAGMENT_SHADER}
        transparent
      />
    </mesh>
  );
}

export type TicketCutShaderViewProps = {
  /** Ticket artwork (data URL or image URL) to tear. */
  imageUrl: string;
  /** Ticket aspect ratio (width / height). */
  aspect?: number;
  /** Start the cut. Resetting to false rewinds it. */
  playing?: boolean;
  durationMs?: number;
  /** How far the stub slides, in UV units. */
  separateBy?: number;
  onDone?: () => void;
  className?: string;
};

/** WebGL view that tears a rendered ticket with a real GLSL shader. */
export function TicketCutShaderView({
  imageUrl,
  aspect = 1200 / 630,
  playing = false,
  durationMs = 1100,
  separateBy = 0.1,
  onDone,
  className,
}: TicketCutShaderViewProps) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    if (!imageUrl) return undefined;
    let disposed = false;
    let loaded: THREE.Texture | null = null;
    new THREE.TextureLoader().load(imageUrl, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      if (disposed) {
        tex.dispose();
        return;
      }
      loaded = tex;
      setTexture(tex);
    });
    return () => {
      disposed = true;
      loaded?.dispose();
      setTexture(null);
    };
  }, [imageUrl]);

  return (
    <div className={className} style={{ width: '100%', height: '100%' }}>
      <Canvas orthographic camera={{ position: [0, 0, 5], zoom: 1 }} gl={{ alpha: true, antialias: true }} dpr={[1, 2]}>
        {texture ? (
          <CutPlane
            texture={texture}
            aspect={aspect}
            playing={playing}
            durationMs={durationMs}
            separateBy={separateBy}
            onDone={onDone}
          />
        ) : null}
      </Canvas>
    </div>
  );
}
