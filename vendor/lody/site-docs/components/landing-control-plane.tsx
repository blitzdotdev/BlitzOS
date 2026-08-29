'use client';

import { useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react';

const ASSET = '/landing';
const LOGO = '/landing/icon-transparent.png';

export type ControlPlaneClient = {
  id: 'desktop' | 'browser' | 'mobile';
  name: string;
};

export type ControlPlaneCopy = {
  kicker: string;
  title: string;
  body: string;
  machines: { mac: string; laptop: string; vps: string };
  clientsLabel: string;
  clients: ControlPlaneClient[];
};

// Everything lives in one 1100×940 viewBox. Cables route the iso way: they hop
// along the two ground axes (slope ±0.5) with right-angle iso turns, like traces
// on a data-center floor, so the packets clearly travel a distance.
// Machines sit ABOVE the hub (work streams out); clients sit BELOW (control
// streams in).
// Each cable hugs the floor along one iso axis, then rises straight up to the
// elevated machine — an L that stays in its own lane, so nothing crosses.
const MACHINE_WIRES = [
  { id: 'mac', d: 'M470 446 L250 356 L250 322', dur: '2.6s', delay: '0s' },
  { id: 'laptop', d: 'M550 416 L566 408 L566 330', dur: '2.2s', delay: '0.5s' },
  { id: 'vps', d: 'M632 448 L865 356 L865 332', dur: '2.7s', delay: '0.3s' },
];

// Drawn client→hub so the streaming dots flow inward (the client controlling Lody).
const CLIENT_WIRES = [
  { id: 'desktop', d: 'M230 700 L476 600', dur: '2.5s', delay: '0.2s' },
  { id: 'browser', d: 'M565 742 L555 648', dur: '2.1s', delay: '0.6s' },
  { id: 'mobile', d: 'M895 700 L624 600', dur: '2.6s', delay: '0.4s' },
];

const MACHINES = [
  { key: 'mac', file: 'iso-mac-mini.svg', x: 68, y: 128, w: 380, h: 228 },
  { key: 'laptop', file: 'iso-laptop.svg', x: 429, y: 79, w: 290, h: 267 },
  { key: 'vps', file: 'iso-vps.svg', x: 730, y: 41, w: 270, h: 346 },
] as const;

function ClientGlyph({ id }: { id: ControlPlaneClient['id'] }) {
  let icon: ReactNode;
  if (id === 'desktop') {
    icon = (
      <>
        <rect className="cp-client-line" x="-30" y="-46" width="60" height="40" rx="3" />
        <path className="cp-client-line" d="M0 -6 V4 M-15 8 H15" />
      </>
    );
  } else if (id === 'browser') {
    icon = (
      <>
        <rect className="cp-client-line" x="-32" y="-44" width="64" height="44" rx="4" />
        <path className="cp-client-line" d="M-32 -32 H32" />
        <circle className="cp-client-dot" cx="-25" cy="-38" r="1.7" />
        <circle className="cp-client-dot" cx="-19" cy="-38" r="1.7" />
        <circle className="cp-client-dot" cx="-13" cy="-38" r="1.7" />
      </>
    );
  } else {
    icon = (
      <>
        <rect className="cp-client-line" x="-15" y="-48" width="30" height="50" rx="5" />
        <path className="cp-client-line" d="M-5 -43 H5 M-5 -3 H5" />
      </>
    );
  }
  return icon;
}

const CLIENT_POS: Record<ControlPlaneClient['id'], { x: number; y: number }> = {
  desktop: { x: 230, y: 700 },
  browser: { x: 565, y: 742 },
  mobile: { x: 895, y: 700 },
};

export function LandingControlPlane({ copy }: { copy: ControlPlaneCopy }) {
  const sceneRef = useRef<HTMLDivElement>(null);

  const handleMove = (event: MouseEvent<HTMLDivElement>) => {
    const el = sceneRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    el.style.setProperty('--rx', String(-py * 4));
    el.style.setProperty('--ry', String(px * 5));
  };

  const handleLeave = () => {
    const el = sceneRef.current;
    if (!el) return;
    el.style.setProperty('--rx', '0');
    el.style.setProperty('--ry', '0');
  };

  return (
    <section className="control-plane" aria-label={copy.title}>
      <div className="cp-inner">
        <div className="cp-copy">
          <p className="cp-kicker">{copy.kicker}</p>
          <h2 className="cp-title">{copy.title}</h2>
          <p className="cp-body">{copy.body}</p>
        </div>

        <div
          className="cp-scene"
          ref={sceneRef}
          onMouseLeave={handleLeave}
          onMouseMove={handleMove}
        >
          <div className="cp-scene__grid" aria-hidden="true" />
          <div className="cp-scene__glow" aria-hidden="true" />

          <div className="cp-stage">
            <svg
              className="cp-svg"
              viewBox="0 0 1100 940"
              fill="none"
              role="img"
              aria-label={copy.title}
              preserveAspectRatio="xMidYMid meet"
            >
              <defs>
                <linearGradient id="cp-holo-cone" x1="0" y1="1" x2="0" y2="0">
                  <stop offset="0" stopColor="hsl(190 92% 58%)" stopOpacity="0.3" />
                  <stop offset="1" stopColor="hsl(190 92% 58%)" stopOpacity="0" />
                </linearGradient>
              </defs>

              {/* Machine conduits (behind machines) — work streams hub → machine */}
              {MACHINE_WIRES.map((wire) => (
                <g key={wire.id}>
                  <path className="cp-wire" d={wire.d} />
                  <path
                    className="cp-wire-flow"
                    d={wire.d}
                    style={{ '--flow-dur': wire.dur, '--flow-delay': wire.delay } as CSSProperties}
                  />
                </g>
              ))}

              {MACHINES.map((m) => (
                <image
                  key={m.key}
                  className="cp-machine"
                  href={`${ASSET}/${m.file}`}
                  x={m.x}
                  y={m.y}
                  width={m.w}
                  height={m.h}
                />
              ))}

              {/* Data-center hub — stacked rack units, status LEDs, projector top */}
              <g className="cp-hub">
                <path className="cp-hub-face" d="M415 480 550 548 550 640 415 572 Z" />
                <path className="cp-hub-face" d="M685 480 550 548 550 640 685 572 Z" />
                <path
                  className="cp-hub-top cp-hub-top--lit"
                  d="M550 412 685 480 550 548 415 480 Z"
                />
                <path
                  className="cp-hub-edge"
                  d="M550 412 685 480 685 572 550 640 415 572 415 480 Z"
                />
                <path className="cp-hub-edge" d="M550 548 550 640" />
                <path className="cp-hub-seam" d="M415 497 550 565 685 497" />
                <path className="cp-hub-seam" d="M415 513 550 581 685 513" />
                <path className="cp-hub-seam" d="M415 530 550 598 685 530" />
                <path className="cp-hub-seam" d="M415 546 550 614 685 546" />
                <circle className="cp-hub-led" cx="598" cy="525" r="2.6" />
                <circle className="cp-hub-led" cx="598" cy="541" r="2.6" />
                <circle className="cp-hub-led" cx="598" cy="557" r="2.6" />
                <ellipse className="cp-hub-emitter" cx="550" cy="479" rx="52" ry="26" />
              </g>

              {/* Holographic Lody projection — upright (no perspective) */}
              <g className="cp-holo-group">
                <path className="cp-holo-cone" d="M524 470 L500 388 L600 388 L576 470 Z" />
                <image className="cp-holo" href={LOGO} x="496" y="300" width="108" height="108" />
              </g>

              {/* Client conduits (in front of hub) — control streams client → hub */}
              {CLIENT_WIRES.map((wire) => (
                <g key={wire.id}>
                  <path className="cp-wire" d={wire.d} />
                  <path
                    className="cp-wire-flow cp-wire-flow--control"
                    d={wire.d}
                    style={{ '--flow-dur': wire.dur, '--flow-delay': wire.delay } as CSSProperties}
                  />
                </g>
              ))}

              {copy.clients.map((client) => {
                const pos = CLIENT_POS[client.id];
                return (
                  <g
                    className="cp-client"
                    key={client.id}
                    transform={`translate(${pos.x} ${pos.y}) scale(1.35)`}
                  >
                    <ClientGlyph id={client.id} />
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      </div>
    </section>
  );
}
