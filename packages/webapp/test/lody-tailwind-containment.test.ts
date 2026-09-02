/**
 * Phase-0 Tailwind containment exit test (plans/LODY-SESSIONS.md §7.4, §10).
 *
 * The question this answers: with the vendored Lody stylesheet loaded, does
 * anything about our own shell surfaces change? The verdict it produces is
 * written up in `plans/evidence/lody-phase0.md`.
 *
 * WHY NOT `getComputedStyle`
 * --------------------------
 * The obvious test — render both surfaces and compare computed styles — cannot
 * work here. jsdom parses `@layer` into a `CSSLayerBlockRule` but its cascade
 * ignores layered rules entirely, so a layered sheet appears to change nothing
 * and every containment assertion passes vacuously. The first test below pins
 * that jsdom behaviour so this reasoning cannot rot silently.
 *
 * WHAT IT DOES INSTEAD
 * --------------------
 * It applies the real cascade rule by construction. Our own stylesheets are
 * unlayered and the Lody sheet is inside `@layer lody`, and an unlayered
 * declaration beats a layered one at any specificity. So for a given element:
 *
 *     bleed = { properties Lody declares on it } - { properties we declare on it }
 *
 * Everything in that difference is a property we never set and Lody now does.
 * Selector matching is jsdom's (`Element.matches`, which is reliable); the
 * cascade is not consulted at all. Both sides expand shorthands to longhands
 * so `background: …` on our side correctly outranks `background-color: …` on
 * theirs.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Rule } from "postcss";
// Compiled through the app's own plugin pipeline: Tailwind v4 plus
// `lodyCascadeLayerPlugin`. `test.css.include` in vite.config.ts is what makes
// this one stylesheet real instead of an empty stub.
import lodyCss from "../src/lody/lody-surface.css?inline";

/** Every stylesheet `src/main.tsx` loads, in load order. */
const BLITZ_STYLESHEETS = [
  "tokens.css",
  "webapp-icons.css",
  "webapp-base.css",
  "webapp-shell.css",
  "webapp-workspace.css",
  "webapp-select.css",
  "files-drive.css",
  "drive-shell.css",
  "strip-rail.css",
  "files.css",
  "confirmation-dialog.css",
  "workspace-details-dialog.css",
  "loading-skeleton.css",
  "create-workspace-dialog.css",
  "settings.css",
  "invite-redeem.css",
];

/**
 * Shorthands whose longhands a competing declaration has to beat. Only the
 * ones either sheet actually uses; an unknown property expands to itself.
 */
const LONGHANDS: Record<string, readonly string[]> = {
  background: [
    "background-color",
    "background-image",
    "background-position",
    "background-size",
    "background-repeat",
    "background-attachment",
    "background-origin",
    "background-clip",
  ],
  border: ["border-width", "border-style", "border-color"],
  "border-top": ["border-top-width", "border-top-style", "border-top-color"],
  "border-bottom": ["border-bottom-width", "border-bottom-style", "border-bottom-color"],
  "border-left": ["border-left-width", "border-left-style", "border-left-color"],
  "border-right": ["border-right-width", "border-right-style", "border-right-color"],
  margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  outline: ["outline-color", "outline-style", "outline-width"],
  font: [
    "font-family",
    "font-size",
    "font-style",
    "font-variant",
    "font-weight",
    "font-stretch",
    "line-height",
  ],
  transition: [
    "transition-property",
    "transition-duration",
    "transition-timing-function",
    "transition-delay",
  ],
  animation: [
    "animation-name",
    "animation-duration",
    "animation-timing-function",
    "animation-delay",
    "animation-iteration-count",
    "animation-direction",
    "animation-fill-mode",
    "animation-play-state",
  ],
  "text-decoration": [
    "text-decoration-line",
    "text-decoration-color",
    "text-decoration-style",
    "text-decoration-thickness",
  ],
  "list-style": ["list-style-type", "list-style-position", "list-style-image"],
  overflow: ["overflow-x", "overflow-y"],
  inset: ["top", "right", "bottom", "left"],
};

function expand(property: string): readonly string[] {
  const longhands = LONGHANDS[property];
  return longhands === undefined ? [property] : [property, ...longhands];
}

interface FlatRule {
  readonly selector: string;
  readonly properties: readonly string[];
}

/**
 * Every style rule the sheet contains, layer nesting and conditional at-rules
 * flattened away. `@keyframes` steps are dropped (they are not selectors), and
 * so are nested `&` rules, which cannot match on their own.
 */
function flattenStyleRules(css: string): FlatRule[] {
  const flat: FlatRule[] = [];
  postcss.parse(css).walkRules((rule: Rule) => {
    for (let node: unknown = rule.parent; node; node = (node as { parent?: unknown }).parent) {
      const atRule = node as AtRule;
      if (atRule.type === "atrule" && atRule.name.endsWith("keyframes")) return;
    }
    if (rule.selector.includes("&")) return;
    const properties: string[] = [];
    rule.walkDecls((declaration) => {
      if (declaration.parent === rule) properties.push(...expand(declaration.prop));
    });
    if (properties.length > 0) flat.push({ selector: rule.selector, properties });
  });
  return flat;
}

function propertiesMatching(rules: readonly FlatRule[], element: Element): Set<string> {
  const properties = new Set<string>();
  for (const rule of rules) {
    let matches = false;
    try {
      matches = element.matches(rule.selector);
    } catch {
      // A selector jsdom's engine cannot evaluate (two of them, both
      // `::-webkit-` pseudo-elements) is not a property on any element.
      continue;
    }
    if (matches) for (const property of rule.properties) properties.add(property);
  }
  return properties;
}

const here = dirname(fileURLToPath(import.meta.url));
const blitzCss = BLITZ_STYLESHEETS.map((file) =>
  readFileSync(join(here, "..", "src", file), "utf8"),
).join("\n");
/* The compensation sheet is measured SEPARATELY from the rest of our CSS, so
   the bleed table below keeps meaning what it meant in phase 0: "what the
   vendored sheet reaches that our product CSS does not declare". Folding it in
   would make the table read as zero and prove nothing. */
const compensationCss = readFileSync(join(here, "..", "src", "lody", "lody-compensation.css"), "utf8");

const lodyRules = flattenStyleRules(lodyCss);
const blitzRules = flattenStyleRules(blitzCss);
const compensationRules = flattenStyleRules(compensationCss);

/** One element per BlitzOS surface the plan names, plus bare native elements. */
const PROBE_MARKUP = `
    <aside class="session-rail"><div class="session-list">
      <div class="shell-s"><span class="shell-s__t">tab</span></div>
    </div></aside>
    <button id="probe-button">New tab</button>
    <input id="probe-input" />
    <a id="probe-link" href="#">link</a>
    <h1 id="probe-h1">Heading</h1>
    <ul id="probe-ul"><li id="probe-li">one</li></ul>
    <img id="probe-img" alt="" />
    <table id="probe-table"><tbody><tr><td>x</td></tr></tbody></table>`;

/** The bare probes, under `#root` and NOT under a shell root — the shape phase
 * 0 measured. The compensation test below re-mounts the same markup inside
 * `.drive-shell`, which is where the product really renders it. */
function probeDocument(): Document {
  document.body.innerHTML = `<div id="root">${PROBE_MARKUP}</div>`;
  return document;
}

/**
 * The measured verdict, pinned. A rise means the vendored sheet reaches
 * further into our surfaces than it did; a fall means containment improved and
 * this list should come down with it.
 */
const EXPECTED_BLEED: Record<string, readonly string[]> = {
  html: [
    "-webkit-tap-highlight-color",
    "-webkit-text-size-adjust",
    "animation-duration",
    "animation-iteration-count",
    "border",
    "border-color",
    "border-style",
    "border-width",
    "font-feature-settings",
    "font-variation-settings",
    "line-height",
    "outline-color",
    "padding",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "scroll-behavior",
    "tab-size",
    "transition-duration",
  ],
  body: [
    "-moz-osx-font-smoothing",
    "-webkit-font-smoothing",
    "-webkit-tap-highlight-color",
    "-webkit-text-size-adjust",
    "animation-duration",
    "animation-iteration-count",
    "border",
    "border-color",
    "border-style",
    "border-width",
    "color-scheme",
    "counter-reset",
    "font-family",
    "font-size",
    "line-height",
    "outline-color",
    "padding",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "scroll-behavior",
    "transition-duration",
  ],
  "#root": [
    "-webkit-tap-highlight-color",
    "-webkit-text-size-adjust",
    "animation-duration",
    "animation-iteration-count",
    "border",
    "border-color",
    "border-style",
    "border-width",
    "outline-color",
    "padding",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "scroll-behavior",
    "transition-duration",
  ],
  ".shell-s": [
    "-webkit-tap-highlight-color",
    "-webkit-text-size-adjust",
    "animation-duration",
    "animation-iteration-count",
    "margin",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-top",
    "outline-color",
    "scroll-behavior",
    "transition-duration",
  ],
  button: [
    "-webkit-text-size-adjust",
    "animation-duration",
    "animation-iteration-count",
    "appearance",
    "background-color",
    "border",
    "border-color",
    "border-radius",
    "border-style",
    "border-width",
    "color",
    "cursor",
    "font-feature-settings",
    "font-variation-settings",
    "letter-spacing",
    "margin",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-top",
    "opacity",
    "outline-color",
    "padding",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "scroll-behavior",
    "transition-duration",
  ],
  input: [
    "-webkit-tap-highlight-color",
    "-webkit-text-size-adjust",
    "animation-duration",
    "animation-iteration-count",
    "background-color",
    "border",
    "border-color",
    "border-radius",
    "border-style",
    "border-width",
    "color",
    "font-feature-settings",
    "font-variation-settings",
    "letter-spacing",
    "margin",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-top",
    "opacity",
    "outline-color",
    "padding",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "scroll-behavior",
    "transition-duration",
  ],
  a: [
    "-webkit-tap-highlight-color",
    "-webkit-text-decoration",
    "-webkit-text-size-adjust",
    "animation-duration",
    "animation-iteration-count",
    "border",
    "border-color",
    "border-style",
    "border-width",
    "margin",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-top",
    "outline-color",
    "padding",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "scroll-behavior",
    "text-decoration",
    "text-decoration-color",
    "text-decoration-line",
    "text-decoration-style",
    "text-decoration-thickness",
    "transition-duration",
  ],
  h1: [
    "-webkit-tap-highlight-color",
    "-webkit-text-size-adjust",
    "animation-duration",
    "animation-iteration-count",
    "border",
    "border-color",
    "border-style",
    "border-width",
    "font-size",
    "font-weight",
    "margin",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-top",
    "outline-color",
    "padding",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "scroll-behavior",
    "transition-duration",
  ],
  ul: [
    "-webkit-tap-highlight-color",
    "-webkit-text-size-adjust",
    "animation-duration",
    "animation-iteration-count",
    "border",
    "border-color",
    "border-style",
    "border-width",
    "list-style",
    "list-style-image",
    "list-style-position",
    "list-style-type",
    "margin",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-top",
    "outline-color",
    "padding",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "scroll-behavior",
    "transition-duration",
  ],
  img: [
    "-webkit-tap-highlight-color",
    "-webkit-text-size-adjust",
    "animation-duration",
    "animation-iteration-count",
    "border",
    "border-color",
    "border-style",
    "border-width",
    "display",
    "height",
    "margin",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-top",
    "max-width",
    "outline-color",
    "padding",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "scroll-behavior",
    "transition-duration",
    "vertical-align",
  ],
  table: [
    "-webkit-tap-highlight-color",
    "-webkit-text-size-adjust",
    "animation-duration",
    "animation-iteration-count",
    "border",
    "border-collapse",
    "border-color",
    "border-style",
    "border-width",
    "margin",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-top",
    "outline-color",
    "padding",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "scroll-behavior",
    "text-indent",
    "transition-duration",
  ],
};

describe("Lody Tailwind containment", () => {
  it("pins the jsdom limitation the rule-level method exists to work around", () => {
    const style = document.createElement("style");
    style.textContent = "@layer probe { p#layer-probe { color: rgb(0, 0, 255); } }";
    document.head.append(style);
    const paragraph = document.createElement("p");
    paragraph.id = "layer-probe";
    document.body.append(paragraph);
    try {
      // A real browser paints this blue. jsdom leaves it at the initial value,
      // so no containment claim may rest on getComputedStyle here.
      expect(window.getComputedStyle(paragraph).color).toBe("rgb(0, 0, 0)");
    } finally {
      style.remove();
      paragraph.remove();
    }
  });

  it("puts the whole compiled Lody sheet inside the `lody` cascade layer", () => {
    const root = postcss.parse(lodyCss);
    const topLevel = root.nodes.filter((node) => node.type !== "comment");
    expect(topLevel).toHaveLength(1);
    const layer = topLevel[0] as AtRule;
    expect(layer.type).toBe("atrule");
    expect(layer.name).toBe("layer");
    expect(layer.params).toBe("lody");
  });

  it("still matches BlitzOS elements — a layer lowers priority, it does not scope", () => {
    const document = probeDocument();
    const body = document.body;
    // Positive control for the whole method: if this ever came back empty the
    // sheet would not have been parsed and every "no bleed" result below would
    // be meaningless.
    expect(propertiesMatching(lodyRules, body).size).toBeGreaterThan(50);
  });

  it("records exactly which properties reach each BlitzOS surface", () => {
    const document = probeDocument();
    const probes: Record<string, Element> = {
      html: document.documentElement,
      body: document.body,
      "#root": document.getElementById("root") as Element,
      ".shell-s": document.querySelector(".shell-s") as Element,
      button: document.getElementById("probe-button") as Element,
      input: document.getElementById("probe-input") as Element,
      a: document.getElementById("probe-link") as Element,
      h1: document.getElementById("probe-h1") as Element,
      ul: document.getElementById("probe-ul") as Element,
      img: document.getElementById("probe-img") as Element,
      table: document.getElementById("probe-table") as Element,
    };

    const measured: Record<string, string[]> = {};
    for (const [name, element] of Object.entries(probes)) {
      const lody = propertiesMatching(lodyRules, element);
      const ours = propertiesMatching(blitzRules, element);
      measured[name] = [...lody]
        .filter((property) => !property.startsWith("--") && !ours.has(property))
        .sort();
    }
    expect(measured).toEqual(EXPECTED_BLEED);
  });

  /**
   * Phase 3's half of the verdict. Phase 0 measured the leak and left it; this
   * asserts the compensation sheet declares every property in it, on the
   * elements the product actually renders — inside `.drive-shell`, which is
   * where every bare `button`, `h1` and `li` of ours lives.
   *
   * The consequence is that an upstream preflight change which widens the leak
   * fails HERE, loudly, instead of quietly restyling the Finder.
   */
  it("compensates every property the vendored sheet reaches inside our shell", () => {
    document.body.innerHTML = `<div id="root"><div class="drive-shell">${PROBE_MARKUP}</div></div>`;
    const probes: Record<string, Element> = {
      html: document.documentElement,
      body: document.body,
      "#root": document.getElementById("root") as Element,
      ".shell-s": document.querySelector(".shell-s") as Element,
      button: document.getElementById("probe-button") as Element,
      input: document.getElementById("probe-input") as Element,
      a: document.getElementById("probe-link") as Element,
      h1: document.getElementById("probe-h1") as Element,
      ul: document.getElementById("probe-ul") as Element,
      img: document.getElementById("probe-img") as Element,
      table: document.getElementById("probe-table") as Element,
    };

    const uncompensated: Record<string, string[]> = {};
    for (const [name, element] of Object.entries(probes)) {
      const lody = propertiesMatching(lodyRules, element);
      const ours = propertiesMatching(blitzRules, element);
      const compensated = propertiesMatching(compensationRules, element);
      const missing = [...lody]
        .filter(
          (property) =>
            !property.startsWith("--") && !ours.has(property) && !compensated.has(property),
        )
        .sort();
      if (missing.length > 0) uncompensated[name] = missing;
    }
    expect(uncompensated).toEqual({});
  });

  it("records the custom-property collisions the Blitz theme overlay must resolve", () => {
    const declared = (rules: readonly FlatRule[]): Set<string> => {
      const names = new Set<string>();
      for (const rule of rules) {
        for (const property of rule.properties) if (property.startsWith("--")) names.add(property);
      }
      return names;
    };
    const lodyVariables = declared(lodyRules);
    const collisions = [...declared(blitzRules)].filter((name) => lodyVariables.has(name)).sort();
    // Both sheets own these names on `:root`, and ours wins everywhere because
    // it is unlayered — including INSIDE the Lody surface, where their
    // components read them as bare HSL triples. §5.3's theme overlay has to
    // redeclare Lody's variables on the surface root, not on `:root`.
    expect(collisions).toEqual([
      "--font-mono",
      "--hover",
      "--muted",
      "--terminal-background",
      "--terminal-selection",
    ]);
  });
});
