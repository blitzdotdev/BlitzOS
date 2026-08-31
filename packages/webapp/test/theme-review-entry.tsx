/**
 * The dev-server entry for `theme-review.html`.
 *
 * It mounts `ThemeReviewPage` under the same theme installation the product
 * uses — `installBlitzLodyTheme` for the registry seed and the generated sheet,
 * `applyBlitzThemeTo(document.documentElement, …)` standing in for the one thing
 * `LodyThemeProvider` does that matters here, which is writing the compiled
 * variables onto `<html>` as an inline style. Mounting their provider instead
 * would pull in next-themes, the Electron IPC bridge and the Shiki registration
 * for no gain: what is under review is the palette, and this is the same
 * palette by the same code path.
 *
 * The toggle writes `data-theme` on the html element, which is exactly what
 * `chooseTheme()` does in the product — so the live switch this page exercises
 * is the live switch `ShellThemeBridge` subscribes to.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeReviewPage } from "./theme-review";
import { applyBlitzThemeTo, installBlitzLodyTheme } from "../src/lody/blitz-theme";
import { chooseTheme, resolvedTheme } from "../src/theme";
import "../src/tokens.css";
import "../src/lody/lody-compensation.css";
import "../src/strip-rail.css";
import "../src/lody/lody-surface.css";
import "../src/lody/lody-surface-shell.css";
import "../src/lody/blitz-skin.css";
import "./lody-fixture-surface.css";
import "./theme-review.css";

function ThemeReviewApp() {
  const [mode, setMode] = useState(() => resolvedTheme());

  useEffect(() => {
    installBlitzLodyTheme(mode);
    // next-themes writes the mode as a CLASS on <html>; every `dark:` variant in
    // the vendored sheet keys off it, so a review page has to move both.
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(mode);
    return applyBlitzThemeTo(document.documentElement, mode);
  }, [mode]);

  return (
    <ThemeReviewPage>
      <div className="review-bar">
        <span>Blitz theme</span>
        {(["dark", "light"] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={mode === choice}
            onClick={() => {
              chooseTheme(choice);
              setMode(choice);
            }}
          >
            {choice === "dark" ? "Dark" : "Light"}
          </button>
        ))}
      </div>
    </ThemeReviewPage>
  );
}

const host = document.getElementById("root");
if (host !== null) {
  createRoot(host).render(
    <StrictMode>
      <ThemeReviewApp />
    </StrictMode>,
  );
}
