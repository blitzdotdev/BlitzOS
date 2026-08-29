'use client';

/**
 * LandingAgentBanner — every ACP agent as an infinite logo strip.
 *
 * Square tiles (icon + name), not circular chips. Two identical rows sit side
 * by side so CSS `translateX(-50%)` loops without a seam. Glyphs are
 * currentColor SVGs so light/dark ink stays free.
 *
 * `inline` drops the absolute positioning so the strip flows in normal layout —
 * used by the subscriptions section as the "any ACP coding agent" logo wall.
 * (Default stays absolute for the legacy bottom-of-section footer usage.)
 */

import { LANDING_AGENTS } from './landing-agents.generated';

function AgentMarkRow({ rowKey }: { rowKey: 'a' | 'b' }) {
  return (
    <ul className="uw-agents__banner-row">
      {LANDING_AGENTS.map((agent) => (
        <li className="uw-agents__tile" key={`${rowKey}-${agent.id}`}>
          <span
            className="uw-agents__glyph"
            aria-hidden="true"
            // Registry marks are trusted build-time assets inlined by
            // scripts/generate-landing-agents.mjs, not user input.
            dangerouslySetInnerHTML={{ __html: agent.svg }}
          />
          <span className="uw-agents__tile-name">{agent.name}</span>
        </li>
      ))}
    </ul>
  );
}

export function LandingAgentBanner({ label, inline = false }: { label: string; inline?: boolean }) {
  return (
    <div
      className={inline ? 'uw-agents__banner uw-agents__banner--inline' : 'uw-agents__banner'}
      role="region"
      aria-label={label}
    >
      <div className="uw-agents__banner-viewport" aria-hidden="true">
        <div className="uw-agents__banner-track">
          <AgentMarkRow rowKey="a" />
          <AgentMarkRow rowKey="b" />
        </div>
      </div>
    </div>
  );
}

export default LandingAgentBanner;
