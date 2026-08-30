import { useEffect, useLayoutEffect } from 'react';
import { useAtomValue } from 'jotai';

import { interfaceFontFamilyAtom } from '@/atoms';
import { applyInterfaceFontFamily } from '@/lib/local-fonts';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function InterfaceFontController({ enabled }: { enabled: boolean }) {
  const interfaceFontFamily = useAtomValue(interfaceFontFamilyAtom);

  useIsomorphicLayoutEffect(() => {
    const root = window.document.documentElement;
    applyInterfaceFontFamily(root, enabled ? interfaceFontFamily : '');

    return () => applyInterfaceFontFamily(root, '');
  }, [enabled, interfaceFontFamily]);

  return null;
}
