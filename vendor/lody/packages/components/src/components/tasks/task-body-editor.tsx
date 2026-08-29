import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';

export type TaskBodyEditorProps = {
  value: string;
  disabled?: boolean;
  /** Called on idle and on blur, not per keystroke. */
  onCommit: (next: string) => void | Promise<void>;
  /** Quote the current selection into a new thread comment. */
  onQuoteSelection?: (quote: string) => void;
  /** Persists an image and returns the stable markdown destination. */
  onImagePaste?: (file: File) => Promise<string | undefined>;
  imageAccept?: string;
};

/**
 * Whether an incoming body from the document layer should replace what the
 * editor currently shows.
 *
 * Lives in this module rather than beside the editor so it can be imported
 * without pulling meowdown, and so it is testable at all: the editor mounts
 * custom elements and a ProseMirror view that jsdom cannot host, which is why
 * the rendering path is verified in a browser instead. Two rules, and the bugs
 * they prevent:
 *
 * - **Not while editing.** Adopting mid-keystroke reflows the paragraph under
 *   the caret. Remote text waits for blur.
 * - **Not our own echo.** A commit travels to Loro and comes back through the
 *   mirror. Without comparing against what we last sent, that echo would be
 *   treated as a remote edit and replace the document the user is still in.
 */
export function shouldAdoptRemoteBody(input: {
  incoming: string;
  lastSynced: string;
  editing: boolean;
}): boolean {
  if (input.editing) return false;
  return input.incoming !== input.lastSynced;
}

/**
 * Whether this browser can run meowdown at all.
 *
 * meowdown's substitution table contains a lookbehind regex built at module
 * scope. Our esbuild target includes iOS Safari < 16.4, which cannot parse
 * lookbehind, so esbuild lowers the literal to `new RegExp(...)` — turning a
 * parse error into a throw the moment the module is imported, which would take
 * the entire lazily-loaded chunk down with it. `apps/web/vite.config.ts` has a
 * build-time guard against exactly this shape (a previous incident killed the
 * streamdown chunk on Safari 16), and this detection is the load-site guard
 * that lets the editor chunk be allowlisted there.
 *
 * Detected rather than assumed from a user-agent string, and computed once at
 * module scope of THIS file — which is safe, because the constructor is inside
 * a try/catch here.
 */
function supportsLookbehind(): boolean {
  try {
    // Built from a string on purpose: a regex literal here would be a parse
    // error on the very browsers this is detecting, taking the module with it.
    const probe = new RegExp('(?<!x)y');
    return probe.test('zy');
  } catch {
    return false;
  }
}

const CAN_RUN_MEOWDOWN = supportsLookbehind();

/**
 * meowdown pulls prosekit, codemirror and katex behind it. Tasks is opt-in
 * (Developer mode + the Tasks beta switch), so loading that tree eagerly would
 * bill every user who has never turned the feature on — the gate is meant to
 * make Tasks absent, and bytes are part of being absent. The routes themselves
 * stay statically imported: they are small, and a stale lazy chunk failing to
 * evaluate after an app update is a documented failure mode in this repo. Only
 * the heavy editor is split out.
 */
const TaskBodyEditorSurface = lazy(() => import('./task-body-editor-surface'));
const TaskBodyEditorFallback = lazy(() => import('./task-body-editor-fallback'));

export function TaskBodyEditor(props: TaskBodyEditorProps) {
  const { t } = useTranslation();

  return (
    <Suspense
      fallback={
        // The body's own text, so the description stays readable while the
        // editor arrives instead of the panel collapsing into a spinner.
        <div className="min-h-24 whitespace-pre-wrap rounded-md p-2 text-sm text-muted-foreground">
          {props.value.trim() || t('tasks.body.empty', 'No description yet. Click to add one.')}
        </div>
      }
    >
      {CAN_RUN_MEOWDOWN ? (
        <TaskBodyEditorSurface {...props} />
      ) : (
        <TaskBodyEditorFallback {...props} />
      )}
    </Suspense>
  );
}
