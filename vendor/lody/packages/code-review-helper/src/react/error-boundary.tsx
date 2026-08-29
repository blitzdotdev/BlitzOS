import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** Rendered when a descendant throws. */
  readonly fallback: ReactNode | ((error: Error) => ReactNode);
  /**
   * When any value here changes (referential), a boundary that is currently in the
   * error state clears it and re-renders its children. Use it to recover after the
   * offending prop has been changed (e.g. a bad diff selection was dropped).
   */
  readonly resetKeys?: readonly unknown[];
  readonly onError?: (error: Error) => void;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

function resetKeysChanged(
  a: readonly unknown[] | undefined,
  b: readonly unknown[] | undefined
): boolean {
  if (a === b) {
    return false;
  }
  if (a === undefined || b === undefined || a.length !== b.length) {
    return true;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (!Object.is(a[index], b[index])) {
      return true;
    }
  }
  return false;
}

/**
 * Minimal error boundary (no dependency). Catches render/lifecycle/effect errors from
 * descendants so a single broken subtree can't white-screen the whole review. Pass
 * `resetKeys` to auto-recover once the offending input changes.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError?.(error);
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error !== null && resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error !== null) {
      const { fallback } = this.props;
      return typeof fallback === 'function' ? fallback(error) : fallback;
    }
    return this.props.children;
  }
}
