import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function AppThemeShell({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'relative h-full w-full overflow-hidden bg-background text-foreground',
        className
      )}
    >
      <div className="relative h-full">{children}</div>
    </div>
  );
}
