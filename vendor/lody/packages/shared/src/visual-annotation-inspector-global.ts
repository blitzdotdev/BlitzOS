import { createVisualCommentInspector } from './visual-annotation-inspector';

import type { VisualCommentInspector } from './visual-annotation-inspector';

declare global {
  interface Window {
    createVisualCommentInspector?: typeof createVisualCommentInspector;
    __lodyVisualCommentInspector?: VisualCommentInspector;
  }
}

if (typeof window !== 'undefined') {
  window.createVisualCommentInspector = createVisualCommentInspector;
}

export { createVisualCommentInspector };
