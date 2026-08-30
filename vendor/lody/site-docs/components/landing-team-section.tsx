'use client';

/**
 * Landing post-demo §2 — team collaboration.
 * Screenshots are placeholders until assets from the checklist land.
 */

export type TeamSectionCopy = {
  /** Optional category label. Omit when the title already carries the meaning. */
  eyebrow?: string;
  title: string;
  body: string;
  features: readonly [
    { title: string; body: string; placeholder: string },
    { title: string; body: string; placeholder: string },
  ];
};

export function LandingTeamSection({ copy }: { copy: TeamSectionCopy }) {
  return (
    <section className="uw-team" aria-labelledby="uw-team-title">
      <div className="uw-team__inner">
        <header className="uw-team__header">
          {copy.eyebrow ? <p className="uw-team__eyebrow">{copy.eyebrow}</p> : null}
          <h2 className="uw-team__title" id="uw-team-title">
            {copy.title}
          </h2>
          <p className="uw-team__body">{copy.body}</p>
        </header>

        <div className="uw-team__grid">
          {copy.features.map((feature) => (
            <article key={feature.title} className="uw-team__card">
              <div className="uw-media-placeholder" data-label={feature.placeholder}>
                <span className="uw-media-placeholder__label">{feature.placeholder}</span>
              </div>
              <div className="uw-team__card-copy">
                <h3 className="uw-team__card-title">{feature.title}</h3>
                <p className="uw-team__card-body">{feature.body}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export default LandingTeamSection;
