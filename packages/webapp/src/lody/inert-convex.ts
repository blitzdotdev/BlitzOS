/**
 * A `ConvexReactClient` that cannot perform I/O
 * (plans/LODY-RUNTIME-DESIGN.md §1.3).
 *
 * A `ConvexProvider` is required even though every query in this composition
 * skips: `useRecoverableConvexQuery`
 * (`vendor/lody/packages/components/src/hooks/use-recoverable-convex-query.ts:38`)
 * calls `ConvexReact.useQueries({})` on the SKIP path too, and `useQueries`
 * throws without a client. Their Storybook preview mirrors this
 * (`.storybook/preview.tsx:104`).
 *
 * The stub is a real `WebSocket` implementation that never connects, rather than
 * an unroutable URL. That makes zero cloud I/O a construction property instead
 * of a configuration accident: a URL is the kind of thing somebody later
 * "fixes", while a socket that has no code path to `open` is inert by shape.
 */
import { ConvexReactClient } from "convex/react";

/** Never opens, never fires, never sends. Implements the whole `WebSocket`
 * surface so no assertion is needed to hand it to a `typeof WebSocket` slot. */
class NeverConnectingWebSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSING = 2 as const;
  static readonly CLOSED = 3 as const;

  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSING = 2 as const;
  readonly CLOSED = 3 as const;

  binaryType: BinaryType = "blob";
  readonly bufferedAmount = 0;
  readonly extensions = "";
  readonly protocol = "";
  /** Stays `CONNECTING` forever; nothing in this class ever advances it. */
  readonly readyState = 0;
  readonly url: string;

  onclose: ((this: WebSocket, event: CloseEvent) => void) | null = null;
  onerror: ((this: WebSocket, event: Event) => void) | null = null;
  onmessage: ((this: WebSocket, event: MessageEvent) => void) | null = null;
  onopen: ((this: WebSocket, event: Event) => void) | null = null;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }

  close(): void {}
  send(): void {}
}

/** The unroutable address is belt to the stub's braces: even a caller that
 * replaced the constructor could not reach anything. */
const NO_CONVEX_ORIGIN = "http://127.0.0.1:1/";

export function createInertConvexClient(): ConvexReactClient {
  return new ConvexReactClient(NO_CONVEX_ORIGIN, {
    // Documented at
    // node_modules/convex/dist/cjs-types/browser/sync/client.d.ts:30.
    webSocketConstructor: NeverConnectingWebSocket,
    unsavedChangesWarning: false,
    logger: false,
  });
}
