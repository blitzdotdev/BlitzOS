import React from 'react';
import { createRoot } from 'react-dom/client';

import { CodeReviewThemeProvider, ReviewRenderer } from '../react';
import type { ReviewBundle } from '../types';
import '../react/styles.css';

function ViewerApp() {
  const [bundle, setBundle] = React.useState<ReviewBundle | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void fetch('/api/review-bundle')
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load review bundle: HTTP ${response.status}`);
        }
        return response.json() as Promise<ReviewBundle>;
      })
      .then(setBundle, (nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
  }, []);

  if (error) {
    return <div className="crh-empty">{error}</div>;
  }
  if (!bundle) {
    return <div className="crh-empty">Loading review...</div>;
  }
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

createRoot(rootElement).render(<ViewerApp />);
