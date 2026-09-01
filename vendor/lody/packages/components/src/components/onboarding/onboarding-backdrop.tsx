import { cn } from '@/lib/utils';

export function OnboardingBackdrop({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none absolute inset-0 bg-muted/20', className)}
    />
  );
}
