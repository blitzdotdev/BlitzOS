/**
 * Entry for the standalone single-file viewer build (see `vite.standalone.config.ts`).
 *
 * Unlike `src/viewer/main.tsx` (which fetches `/api/review-bundle` from a dev
 * server), this entry reads the review snapshot synchronously from a global the
 * CLI injects into the generated HTML: `window.__LODY_REVIEW__`. The build is
 * inlined into one self-contained `.review.html` that opens over `file://` with no
 * server. See `injectReviewSnapshot` in `src/standalone/inject.ts`.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';

import { CodeReviewThemeProvider, ReviewRenderer } from '../react';
import type { ReviewBundleInput } from '../snapshot';
import '../react/styles.css';

declare global {
  interface Window {
    __LODY_REVIEW__?: ReviewBundleInput;
  }
}

function StandaloneApp() {
  const bundle = window.__LODY_REVIEW__;
  if (bundle == null) {
    return <div className="crh-empty">No review data was embedded in this file.</div>;
  }
  // Same wrapper as Storybook's preview decorator (CodeReviewThemeProvider +
  // ReviewRenderer) so the generated HTML and Storybook render identically.
  return (
    <CodeReviewThemeProvider>
      <ReviewRenderer bundle={bundle} />
    </CodeReviewThemeProvider>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root element.');
}

createRoot(rootElement).render(<StandaloneApp />);
