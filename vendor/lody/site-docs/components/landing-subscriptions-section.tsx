'use client';

/**
 * Landing post-demo — bring your own agent subscriptions / logins.
 *
 * Beats:
 *   1. Featured providers you already pay for
 *   2. ACP logo wall — any coding agent that speaks ACP
 * Team collaboration lives under the power (usage / PR) section.
 */

import { LandingAgentBanner } from './landing-agent-banner';
import { LANDING_AGENTS } from './landing-agents.generated';

export type SubscriptionsSectionCopy = {
  /** Optional category label. Omit when the title already carries the meaning. */
  eyebrow?: string;
  title: string;
  body: string;
  note: string;
  providers: readonly { id: string; label: string; hint: string }[];
  /** ACP-openness logo wall: any coding agent that adapts ACP plugs in. */
  wall: {
    title: string;
    body: string;
    /** Accessible region name for the decorative logo marquee. */
    label: string;
  };
};

const MARK_BY_ID = new Map(LANDING_AGENTS.map((agent) => [agent.id, agent]));

/** Map marketing provider ids → mark ids in landing-agents.generated. */
const MARK_ALIASES: Record<string, string> = {
  'claude-code': 'claude-code',
  claude: 'claude-code',
  codex: 'codex',
  grok: 'grok',
  kimi: 'kimi',
};

export function LandingSubscriptionsSection({ copy }: { copy: SubscriptionsSectionCopy }) {
  return (
    <section className="uw-subs" aria-labelledby="uw-subs-title">
      <div className="uw-subs__inner">
        <header className="uw-subs__header">
          {copy.eyebrow ? <p className="uw-subs__eyebrow">{copy.eyebrow}</p> : null}
          <h2 className="uw-subs__title" id="uw-subs-title">
            {copy.title}
          </h2>
          <p className="uw-subs__body">{copy.body}</p>
        </header>

        <ul className="uw-subs__providers">
          {copy.providers.map((provider) => {
            const markId = MARK_ALIASES[provider.id] ?? provider.id;
            const mark = MARK_BY_ID.get(markId);
            return (
              <li key={provider.id} className="uw-subs__provider">
                <span className="uw-subs__provider-mark" aria-hidden="true">
                  {mark ? (
                    <span
                      className="uw-subs__provider-glyph"
                      // Registry marks are trusted build-time assets.
                      dangerouslySetInnerHTML={{ __html: mark.svg }}
                    />
                  ) : (
                    <span className="uw-subs__provider-fallback">{provider.label.slice(0, 1)}</span>
                  )}
                </span>
                <span className="uw-subs__provider-label">{provider.label}</span>
                <span className="uw-subs__provider-hint">{provider.hint}</span>
              </li>
            );
          })}
        </ul>

        <div className="uw-subs__wall">
          <div className="uw-subs__wall-head">
            <h3 className="uw-subs__wall-title">{copy.wall.title}</h3>
            <p className="uw-subs__wall-body">{copy.wall.body}</p>
          </div>
          <LandingAgentBanner label={copy.wall.label} inline />
        </div>

        <p className="uw-subs__note">{copy.note}</p>
      </div>
    </section>
  );
}

export default LandingSubscriptionsSection;
