/**
 * THE ONE THING THAT MAY NOT HAPPEN WHEN THE SESSION SURFACE FAILS: a blank
 * document (BUG-CV-01).
 *
 * The field report. A canary box's tunnel carried zero connections, so every
 * `/webapp/7445/*` call answered 530 and the shell's polls never got their
 * sockets back. The browser ran out, the lazy `SessionSurface` chunk import
 * rejected with `ERR_INSUFFICIENT_RESOURCES` — and because a rejected `lazy()`
 * throws during render with nothing above it to catch, React unmounted the
 * whole tree. Measured: `body.innerText.length` went 87 to 0 on two loads out
 * of two. The rail, the tab strip, the footer and the workspace switcher all
 * went with it, over a feature the member had not asked for yet.
 *
 * The degraded path this repairs to ALREADY EXISTED and already read correctly
 * — blocking the same requests at the network layer rendered "Sessions are
 * unavailable on this workspace: Failed to fetch" on the same build. What was
 * missing was any way to reach it from a chunk that never arrived.
 *
 * SO THE NOTICE LIVES HERE AND NOT IN `SessionSurface.tsx`. The surface is the
 * 3.5 MB chunk; a boundary that had to import it to render its own failure
 * message could not render one. `SessionSurface` imports the notice from here
 * instead, so both halves of the degraded path say the same sentence and
 * `lody-lazy-boundary.test.ts` still passes.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { LODY_SURFACE_CLASS } from "./surface-class.js";

/** The sentence, in one place, because two components render it. */
export const SURFACE_UNAVAILABLE_PREFIX = "Sessions are unavailable on this workspace";

export interface SurfaceUnavailableNoticeProps {
  /** What went wrong, in the words whatever failed used. */
  reason: string;
  /** Omitted where there is nothing to try again — a box on a pre-Lody image
   * will not grow a daemon because a member pressed a button. */
  onRetry?: () => void;
}

export function SurfaceUnavailableNotice(props: SurfaceUnavailableNoticeProps) {
  return (
    <div className="lody-surface__notice" role="alert">
      <p className="lody-surface__notice-title">
        {SURFACE_UNAVAILABLE_PREFIX}: {props.reason}
      </p>
      {props.onRetry !== undefined && (
        <button
          type="button"
          className="lody-surface__notice-action"
          onClick={props.onRetry}
        >
          Try again
        </button>
      )}
    </div>
  );
}

function surfaceFailureReason(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message === "" ? "the session surface failed to load" : message;
}

export interface SurfaceLoadBoundaryProps {
  children: ReactNode;
  /**
   * Builds a FRESH lazy component for the retry.
   *
   * It has to be fresh: React records a rejected `lazy()` payload on the
   * component object itself and re-throws it forever, so re-rendering the same
   * one is not a retry. The region owns that construction, so it owns this.
   */
  onRetry: () => void;
}

interface SurfaceLoadBoundaryState {
  reason: string | null;
}

export class SurfaceLoadBoundary
  extends Component<SurfaceLoadBoundaryProps, SurfaceLoadBoundaryState> {
  override state: SurfaceLoadBoundaryState = { reason: null };

  static getDerivedStateFromError(cause: unknown): SurfaceLoadBoundaryState {
    return { reason: surfaceFailureReason(cause) };
  }

  override componentDidCatch(cause: Error, info: ErrorInfo): void {
    // The one line this path writes. A member who reports "sessions did not
    // open" leaves a console with the real cause in it, rather than a blank
    // page and nothing at all.
    console.error("lody: the session surface failed to render", cause, info.componentStack);
  }

  private readonly retry = (): void => {
    this.setState({ reason: null });
    this.props.onRetry();
  };

  override render(): ReactNode {
    const { reason } = this.state;
    if (reason === null) return this.props.children;
    return (
      <div className={LODY_SURFACE_CLASS}>
        <SurfaceUnavailableNotice reason={reason} onRetry={this.retry} />
      </div>
    );
  }
}
