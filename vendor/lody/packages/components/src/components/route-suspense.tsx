import { Suspense, type ReactNode } from 'react';

export function RouteSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
