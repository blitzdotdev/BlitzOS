import { describe, expect, it } from 'vitest';

import { injectReviewSnapshot, REVIEW_GLOBAL_NAME } from '../src/standalone';

const TEMPLATE_WITH_PLACEHOLDER =
  '<!doctype html><html><head><title>x</title><!--LODY_REVIEW_DATA--></head><body><div id="root"></div><script type="module">app()</script></body></html>';

/** Extracts the JSON assigned to the global from the injected `<script>`. */
function extractInjectedJson(html: string): string {
  const match = new RegExp(`<script>window\\.${REVIEW_GLOBAL_NAME}=(.*?)</script>`, 's').exec(html);
  if (!match?.[1]) {
    throw new Error('No injected data script found');
  }
  return match[1];
}

describe('injectReviewSnapshot', () => {
  it('replaces the placeholder with a global-assignment script', () => {
    const html = injectReviewSnapshot(TEMPLATE_WITH_PLACEHOLDER, { hello: 'world' } as never);

    expect(html).not.toContain('<!--LODY_REVIEW_DATA-->');
    expect(html).toContain(`window.${REVIEW_GLOBAL_NAME}=`);
    // The data script must sit before the module script so the global is defined first.
    expect(html.indexOf(`window.${REVIEW_GLOBAL_NAME}`)).toBeLessThan(
      html.indexOf('<script type="module">')
    );
  });

  it('round-trips the data as valid JSON', () => {
    const data = { version: 1, nested: { items: [1, 2, 3], note: 'café' } };
    const html = injectReviewSnapshot(TEMPLATE_WITH_PLACEHOLDER, data as never);

    expect(JSON.parse(extractInjectedJson(html))).toEqual(data);
  });

  it('escapes < so review text cannot break out of the script element', () => {
    const data = { evil: '</script><script>alert(1)</script>', tag: '<div>' };
    const html = injectReviewSnapshot(TEMPLATE_WITH_PLACEHOLDER, data as never);

    // The raw closing tag must not appear inside the injected data (it is \\u003c-escaped).
    const injected = extractInjectedJson(html);
    expect(injected).not.toContain('</script>');
    expect(injected).toContain('\\u003c');
    // ...yet it still parses back to the original payload.
    expect(JSON.parse(injected)).toEqual(data);
  });

  it('falls back to injecting before </head> when no placeholder is present', () => {
    const template = '<html><head><title>x</title></head><body></body></html>';
    const html = injectReviewSnapshot(template, { a: 1 } as never);

    expect(html).toContain(`<script>window.${REVIEW_GLOBAL_NAME}={"a":1}</script></head>`);
  });

  // Regression: review data inlines reviewed source, which is full of `$` —
  // `${...}` template literals, regex `$&`/`$1`, shell `$'...'`. A *string*
  // replacement makes `String.prototype.replace` expand those patterns ($&, $`,
  // $', $$, $n), splicing template fragments into the JSON and breaking the
  // script (the viewer then shows "No review data was embedded"). The injection
  // must use a function replacement so the data is inserted verbatim.
  it('does not expand $ replacement patterns from review data (placeholder path)', () => {
    const data = {
      // every dangerous special pattern + a realistic template-literal snippet
      shell: "name.replace(/x/g, '$&'); a=$`b; c=$'d; e=$$f; g=$1h",
      tmpl: 'return `${String(value)}`;',
    };
    const html = injectReviewSnapshot(TEMPLATE_WITH_PLACEHOLDER, data as never);

    const injected = extractInjectedJson(html);
    // The template must NOT leak into the data ($' / $` would splice it in).
    expect(injected).not.toContain('<!--LODY_REVIEW_DATA-->');
    expect(injected).not.toContain('<title>');
    expect(injected).not.toContain('id="root"');
    // ...and the data round-trips exactly.
    expect(JSON.parse(injected)).toEqual(data);
  });

  it('does not expand $ replacement patterns from review data (</head> fallback)', () => {
    const template = '<html><head><title>x</title></head><body><div id="root"></div></body></html>';
    const data = { s: "a$'b$`c$&d$$e" };
    const html = injectReviewSnapshot(template, data as never);

    const injected = extractInjectedJson(html);
    expect(injected).not.toContain('id="root"');
    expect(JSON.parse(injected)).toEqual(data);
  });
});
