import { useCallback, useLayoutEffect, useRef } from 'react';
import { useTheme } from '@/theme-provider';

/**
 * Keeps the entire desktop onboarding in Light, including reloads, then hands
 * the product back to the system color scheme when onboarding ends.
 */
export function useOnboardingThemeLifecycle(): () => void {
  const { setTheme } = useTheme();
  const setThemeRef = useRef(setTheme);
  setThemeRef.current = setTheme;

  useLayoutEffect(() => {
    setThemeRef.current('light');

    return () => {
      setThemeRef.current('system');
    };
  }, []);

  return useCallback(() => {
    setThemeRef.current('system');
  }, []);
}
