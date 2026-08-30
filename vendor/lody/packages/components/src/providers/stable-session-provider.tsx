import { StableSessionContext, useStableSessionInternal } from '../hooks/useStableSession';

export function StableSessionProvider({ children }: { children: React.ReactNode }) {
  const value = useStableSessionInternal();
  return <StableSessionContext.Provider value={value}>{children}</StableSessionContext.Provider>;
}
