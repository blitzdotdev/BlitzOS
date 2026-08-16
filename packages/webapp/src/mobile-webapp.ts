import { useEffect, useState } from 'react';

export const MOBILE_WEBAPP_QUERY = '(max-width: 899px)';

export function useMobileWebApp(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_WEBAPP_QUERY).matches);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_WEBAPP_QUERY);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return mobile;
}

export type VisualViewportGeometry = {
  height: number;
  offsetTop: number;
  source: 'initial' | 'orientation' | 'viewport' | 'window';
};

type VisualViewportListener = (geometry: VisualViewportGeometry) => void;

const visualViewportListeners = new Set<VisualViewportListener>();
let stopVisualViewportObservation: (() => void) | null = null;

function readVisualViewportGeometry(
  source: VisualViewportGeometry['source'],
): VisualViewportGeometry {
  return {
    height: Math.round(window.visualViewport?.height ?? window.innerHeight),
    offsetTop: Math.round(window.visualViewport?.offsetTop ?? 0),
    source,
  };
}

function notifyVisualViewportListeners(source: VisualViewportGeometry['source']) {
  const geometry = readVisualViewportGeometry(source);
  for (const listener of visualViewportListeners) listener(geometry);
}

export function observeVisualViewportGeometry(listener: VisualViewportListener): () => void {
  visualViewportListeners.add(listener);
  if (!stopVisualViewportObservation) {
    const viewport = window.visualViewport;
    const handleViewportChange = () => notifyVisualViewportListeners('viewport');
    const handleWindowResize = () => notifyVisualViewportListeners('window');
    const handleOrientationChange = () => notifyVisualViewportListeners('orientation');
    viewport?.addEventListener('resize', handleViewportChange);
    viewport?.addEventListener('scroll', handleViewportChange);
    window.addEventListener('resize', handleWindowResize);
    window.addEventListener('orientationchange', handleOrientationChange);
    stopVisualViewportObservation = () => {
      viewport?.removeEventListener('resize', handleViewportChange);
      viewport?.removeEventListener('scroll', handleViewportChange);
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('orientationchange', handleOrientationChange);
    };
  }
  listener(readVisualViewportGeometry('initial'));
  return () => {
    visualViewportListeners.delete(listener);
    if (visualViewportListeners.size > 0) return;
    stopVisualViewportObservation?.();
    stopVisualViewportObservation = null;
  };
}

export function bindVisualViewportGeometry(element: HTMLElement): () => void {
  const stopObserving = observeVisualViewportGeometry(({ height, offsetTop }) => {
    element.style.setProperty('--mobile-viewport-height', `${height}px`);
    element.style.setProperty('--mobile-viewport-top', `${offsetTop}px`);
  });
  return () => {
    stopObserving();
    element.style.removeProperty('--mobile-viewport-height');
    element.style.removeProperty('--mobile-viewport-top');
  };
}
