'use client';

/**
 * Landing — same control plane in the terminal.
 * For people, scripts, and external systems — not only agent-to-agent MCP.
 */

export type CliSectionCopy = {
  title: string;
  body: string;
  /** Shell prompt glyph, e.g. `$`. */
  prompt: string;
  lines: readonly {
    /** Optional `#` caption rendered above the command (where it runs). */
    caption?: string;
    /** Full command string after the prompt. */
    cmd: string;
  }[];
};

export function LandingCliSection({ copy }: { copy: CliSectionCopy }) {
  return (
    <section className="uw-cli" aria-labelledby="uw-cli-title">
      <div className="uw-cli__inner">
        <header className="uw-cli__header">
          <h2 className="uw-cli__title" id="uw-cli-title">
            {copy.title}
          </h2>
          <p className="uw-cli__body">{copy.body}</p>
        </header>

        <div className="uw-cli__terminal" role="img" aria-label={copy.title}>
          <div className="uw-cli__chrome" aria-hidden="true">
            <span className="uw-cli__chrome-title">lody</span>
          </div>
          <pre className="uw-cli__body-term">
            <code>
              {copy.lines.map((line) => (
                <span key={line.cmd} className="uw-cli__group">
                  {line.caption ? <span className="uw-cli__caption"># {line.caption}</span> : null}
                  <span className="uw-cli__line">
                    <span className="uw-cli__prompt">{copy.prompt}</span>
                    <span className="uw-cli__cmd">{line.cmd}</span>
                  </span>
                </span>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </section>
  );
}

export default LandingCliSection;
