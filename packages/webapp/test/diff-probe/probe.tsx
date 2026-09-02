/**
 * Mounts the REAL vendored DiffViewer exactly the way the All Changes panel's
 * DiffFileBlock does for a `status: 'ready'` file (old/new text, defaultOpen,
 * deferRenderUntilOpen), through the product build pipeline, in a REAL browser.
 *
 * Reports into `window.__probe`:
 * - `shadowLength`: how much HTML Pierre's `diffs-container` shadow root holds
 * - `hasPre`: whether the rendered diff `<pre>` arrived
 * - `errors`: window errors + unhandled rejections seen along the way
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DiffViewer } from "@lody/components/ui/diff-viewer/diff-viewer";

declare global {
  interface Window {
    __probe?: Record<string, unknown>;
  }
}

const probe: Record<string, unknown> = { errors: [] as string[], workers: [] as string[] };
window.__probe = probe;
const errors = probe.errors as string[];
const workers = probe.workers as string[];
window.addEventListener("error", (event) => {
  errors.push(`error: ${event.message}`);
});
window.addEventListener("unhandledrejection", (event) => {
  errors.push(`unhandledrejection: ${String(event.reason)}`);
});

// Observe every worker the page constructs, what it is asked, what it answers.
const NativeWorker = window.Worker;
// eslint-disable-next-line no-native-reassign
window.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    const label = String(url);
    workers.push(`construct: ${label}`);
    this.addEventListener("error", (event) =>
      workers.push(`worker-error: ${label} ${(event as ErrorEvent).message ?? ""}`),
    );
    this.addEventListener("message", (event) => {
      if (workers.length < 40) {
        workers.push(`msg-in: ${JSON.stringify((event as MessageEvent).data).slice(0, 160)}`);
      }
    });
    const post = this.postMessage.bind(this);
    this.postMessage = ((message: unknown, ...rest: never[]) => {
      if (workers.length < 40) {
        workers.push(`msg-out: ${JSON.stringify(message)?.slice(0, 160)}`);
      }
      return post(message as never, ...(rest as never[]));
    }) as typeof this.postMessage;
  }
} as typeof Worker;

const OLD_TEXT = "";
const NEW_TEXT = "line one\nline two\nline three\n";

function sample(): void {
  const container = document.querySelector("diffs-container");
  const html = container?.shadowRoot?.innerHTML ?? "";
  probe.shadowLength = html.length;
  probe.hasPre = html.includes("<pre");
  probe.hasContainer = container !== null;
}

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <StrictMode>
    <div style={{ width: 800 }}>
      <DiffViewer
        path="scratch-diff-test.txt"
        oldText={OLD_TEXT}
        newText={NEW_TEXT}
        defaultOpen
        deferRenderUntilOpen
        responsiveSplit
        cachePrerenderedHtml={false}
      />
    </div>
  </StrictMode>,
);

let ticks = 0;
const interval = window.setInterval(() => {
  ticks += 1;
  sample();
  probe.ticks = ticks;
  if ((probe.hasPre as boolean) || ticks > 40) {
    window.clearInterval(interval);
    probe.done = true;
  }
}, 250);
